import { Socket } from "node:net";
import { execFileSync } from "node:child_process";

import { WebDriverAgent } from "./webdriver-agent";
import { ActionableError, Button, InstalledApp, Robot, ScreenSize, SwipeDirection, ScreenElement, Orientation } from "./robot";
import { validatePackageName, validateLocale } from "./utils";

const WDA_PORT = 8100;
const IOS_TUNNEL_PORT = 60105;

// farm fork (#1590): go-ios calls are BOUNDED. Upstream 0.0.60 ran every
// `execFileSync(ios, …)` with no timeout, so a wedged usbmux/RSD path hung the
// server forever. 20s is generous for `ios list`/`info`/`apps` over a healthy tunnel.
const GO_IOS_TIMEOUT_MS = (() => {
	const raw = Number.parseInt(process.env.MOBILEMCP_GOIOS_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(raw) && raw >= 1_000 && raw <= 120_000 ? raw : 20_000;
})();

// farm fork (#1590): the WDA endpoint is PER-DEVICE + env-configurable, not the fixed
// `localhost:8100`. Upstream pinned every device to 8100, so on a rack where each
// iPhone's WebDriverAgent is forwarded to its OWN local port, two phones cross-wired
// (a tap for device B hit whatever phone owned 8100). A host that runs a per-device
// WDA forward exports `MOBILEMCP_WDA_PORTS="<udid>=<port>,…"`; `MOBILEMCP_WDA_PORT`
// is a single override; default stays 8100 for the classic single-device setup.
export interface WdaEndpoint { host: string; port: number }

const parseWdaPortsMap = (raw: string | undefined): Map<string, number> => {
	const map = new Map<string, number>();
	if (!raw) {
		return map;
	}
	for (const pair of raw.split(",")) {
		const idx = pair.lastIndexOf("=");
		if (idx <= 0) {
			continue;
		}
		const udid = pair.slice(0, idx).trim();
		const port = Number.parseInt(pair.slice(idx + 1).trim(), 10);
		if (udid && Number.isInteger(port) && port > 0 && port < 65536) {
			map.set(udid, port);
		}
	}
	return map;
};

export const resolveWdaEndpoint = (deviceId: string): WdaEndpoint => {
	const host = (process.env.MOBILEMCP_WDA_HOST ?? "localhost").trim() || "localhost";
	const perDevice = parseWdaPortsMap(process.env.MOBILEMCP_WDA_PORTS).get(deviceId);
	if (perDevice) {
		return { host, port: perDevice };
	}
	const single = Number.parseInt(process.env.MOBILEMCP_WDA_PORT ?? "", 10);
	if (Number.isInteger(single) && single > 0 && single < 65536) {
		return { host, port: single };
	}
	return { host, port: WDA_PORT };
};

interface ListCommandOutput {
	deviceList: string[];
}

interface VersionCommandOutput {
	version: string;
}

interface InfoCommandOutput {
	DeviceClass: string;
	DeviceName: string;
	ProductName: string;
	ProductType: string;
	ProductVersion: string;
	PhoneNumber: string;
	TimeZone: string;
}

export interface IosDevice {
	deviceId: string;
	deviceName: string;
}

const getGoIosPath = (): string => {
	if (process.env.GO_IOS_PATH) {
		return process.env.GO_IOS_PATH;
	}

	// fallback to go-ios in PATH via `npm install -g go-ios`
	return "ios";
};

export class IosRobot implements Robot {

	// farm fork (#1590): resolve this device's OWN WDA endpoint once, and cache the
	// WebDriverAgent so its session (see webdriver-agent.ts) survives across actions.
	private readonly endpoint: WdaEndpoint;
	private wdaInstance: WebDriverAgent | null = null;

	public constructor(private deviceId: string) {
		this.endpoint = resolveWdaEndpoint(deviceId);
	}

	private isListeningOnPort(port: number): Promise<boolean> {
		return new Promise(resolve => {
			const client = new Socket();
			const done = (ok: boolean) => {
				client.destroy();
				resolve(ok);
			};
			// farm fork (#1590): a bounded connect probe — never hang on a wedged host.
			client.setTimeout(3_000);
			client.once("timeout", () => done(false));
			client.connect(port, this.endpoint.host, () => done(true));
			client.on("error", () => done(false));
		});
	}

	private async isTunnelRunning(): Promise<boolean> {
		return await this.isListeningOnPort(IOS_TUNNEL_PORT);
	}

	private async isWdaForwardRunning(): Promise<boolean> {
		return await this.isListeningOnPort(this.endpoint.port);
	}

	private async assertTunnelRunning(): Promise<void> {
		if (await this.isTunnelRequired()) {
			if (!(await this.isTunnelRunning())) {
				throw new ActionableError("iOS tunnel is not running, please see https://github.com/mobile-next/mobile-mcp/wiki/");
			}
		}
	}

	private async wda(): Promise<WebDriverAgent> {

		await this.assertTunnelRunning();

		if (!(await this.isWdaForwardRunning())) {
			throw new ActionableError("Port forwarding to WebDriverAgent is not running (tunnel okay), please see https://github.com/mobile-next/mobile-mcp/wiki/");
		}

		// farm fork (#1590): cache the WDA instance (its session persists across actions).
		if (!this.wdaInstance) {
			this.wdaInstance = new WebDriverAgent(this.endpoint.host, this.endpoint.port);
		}
		const wda = this.wdaInstance;

		if (!(await wda.isRunning())) {
			throw new ActionableError("WebDriverAgent is not running on device (tunnel okay, port forwarding okay), please see https://github.com/mobile-next/mobile-mcp/wiki/");
		}

		return wda;
	}

	private async ios(...args: string[]): Promise<string> {
		// farm fork (#1590): bounded so a wedged go-ios/usbmux can't hang forever.
		return execFileSync(getGoIosPath(), ["--udid", this.deviceId, ...args], { timeout: GO_IOS_TIMEOUT_MS }).toString();
	}

	public async getIosVersion(): Promise<string> {
		const output = await this.ios("info");
		const json = JSON.parse(output);
		return json.ProductVersion;
	}

	private async isTunnelRequired(): Promise<boolean> {
		const version = await this.getIosVersion();
		const args = version.split(".");
		return parseInt(args[0], 10) >= 17;
	}

	public async getScreenSize(): Promise<ScreenSize> {
		const wda = await this.wda();
		return await wda.getScreenSize();
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const wda = await this.wda();
		await wda.swipe(direction);
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance?: number): Promise<void> {
		const wda = await this.wda();
		await wda.swipeFromCoordinate(x, y, direction, distance);
	}

	public async listApps(): Promise<InstalledApp[]> {
		await this.assertTunnelRunning();

		const output = await this.ios("apps", "--all", "--list");
		return output
			.split("\n")
			.map(line => {
				const [packageName, appName] = line.split(" ");
				return {
					packageName,
					appName,
				};
			});
	}

	public async launchApp(packageName: string, locale?: string): Promise<void> {
		validatePackageName(packageName);
		await this.assertTunnelRunning();
		const args = ["launch", packageName];
		if (locale) {
			validateLocale(locale);
			const locales = locale.split(",").map(l => l.trim());
			args.push("-AppleLanguages", `(${locales.join(", ")})`);
			args.push("-AppleLocale", locales[0]);
		}

		await this.ios(...args);
	}

	public async terminateApp(packageName: string): Promise<void> {
		validatePackageName(packageName);
		await this.assertTunnelRunning();
		await this.ios("kill", packageName);
	}

	public async installApp(path: string): Promise<void> {
		await this.assertTunnelRunning();
		try {
			await this.ios("install", "--path", path);
		} catch (error: any) {
			const stdout = error.stdout ? error.stdout.toString() : "";
			const stderr = error.stderr ? error.stderr.toString() : "";
			const output = (stdout + stderr).trim();
			throw new ActionableError(output || error.message);
		}
	}

	public async uninstallApp(bundleId: string): Promise<void> {
		await this.assertTunnelRunning();
		try {
			await this.ios("uninstall", "--bundleid", bundleId);
		} catch (error: any) {
			const stdout = error.stdout ? error.stdout.toString() : "";
			const stderr = error.stderr ? error.stderr.toString() : "";
			const output = (stdout + stderr).trim();
			throw new ActionableError(output || error.message);
		}
	}

	public async openUrl(url: string): Promise<void> {
		const wda = await this.wda();
		await wda.openUrl(url);
	}

	public async sendKeys(text: string): Promise<void> {
		const wda = await this.wda();
		await wda.sendKeys(text);
	}

	public async pressButton(button: Button): Promise<void> {
		const wda = await this.wda();
		await wda.pressButton(button);
	}

	public async tap(x: number, y: number): Promise<void> {
		const wda = await this.wda();
		await wda.tap(x, y);
	}

	public async doubleTap(x: number, y: number): Promise<void> {
		const wda = await this.wda();
		await wda.doubleTap(x, y);
	}

	public async longPress(x: number, y: number, duration: number): Promise<void> {
		const wda = await this.wda();
		await wda.longPress(x, y, duration);
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		const wda = await this.wda();
		return await wda.getElementsOnScreen();
	}

	public async getScreenshot(): Promise<Buffer> {
		const wda = await this.wda();
		return await wda.getScreenshot();

		/* alternative:
		await this.assertTunnelRunning();
		const tmpFilename = path.join(tmpdir(), `screenshot-${randomBytes(8).toString("hex")}.png`);
		await this.ios("screenshot", "--output", tmpFilename);
		const buffer = readFileSync(tmpFilename);
		unlinkSync(tmpFilename);
		return buffer;
		*/
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		const wda = await this.wda();
		await wda.setOrientation(orientation);
	}

	public async getOrientation(): Promise<Orientation> {
		const wda = await this.wda();
		return await wda.getOrientation();
	}
}

export class IosManager {

	public isGoIosInstalled(): boolean {
		try {
			const output = execFileSync(getGoIosPath(), ["version"], { stdio: ["pipe", "pipe", "ignore"], timeout: GO_IOS_TIMEOUT_MS }).toString();
			const json: VersionCommandOutput = JSON.parse(output);
			return json.version !== undefined && (json.version.startsWith("v") || json.version === "local-build");
		} catch (error) {
			return false;
		}
	}

	public getDeviceName(deviceId: string): string {
		const output = execFileSync(getGoIosPath(), ["info", "--udid", deviceId], { timeout: GO_IOS_TIMEOUT_MS }).toString();
		const json: InfoCommandOutput = JSON.parse(output);
		return json.DeviceName;
	}

	public getDeviceInfo(deviceId: string): InfoCommandOutput {
		const output = execFileSync(getGoIosPath(), ["info", "--udid", deviceId], { timeout: GO_IOS_TIMEOUT_MS }).toString();
		const json: InfoCommandOutput = JSON.parse(output);
		return json;
	}

	public listDevices(): IosDevice[] {
		if (!this.isGoIosInstalled()) {
			console.error("go-ios is not installed, no physical iOS devices can be detected");
			return [];
		}

		const output = execFileSync(getGoIosPath(), ["list"], { timeout: GO_IOS_TIMEOUT_MS }).toString();
		const json: ListCommandOutput = JSON.parse(output);
		const devices = json.deviceList.map(device => ({
			deviceId: device,
			deviceName: this.getDeviceName(device),
		}));

		return devices;
	}

	public listDevicesWithDetails(): Array<IosDevice & { version: string }> {
		if (!this.isGoIosInstalled()) {
			console.error("go-ios is not installed, no physical iOS devices can be detected");
			return [];
		}

		const output = execFileSync(getGoIosPath(), ["list"], { timeout: GO_IOS_TIMEOUT_MS }).toString();
		const json: ListCommandOutput = JSON.parse(output);
		const devices = json.deviceList.map(device => {
			const info = this.getDeviceInfo(device);
			return {
				deviceId: device,
				deviceName: info.DeviceName,
				version: info.ProductVersion,
			};
		});

		return devices;
	}
}
