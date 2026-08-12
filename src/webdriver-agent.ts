import { ActionableError, SwipeDirection, ScreenSize, ScreenElement, Orientation } from "./robot";

export interface SourceTreeElementRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SourceTreeElement {
	type: string;
	label?: string;
	name?: string;
	value?: string;
	rawIdentifier?: string;
	rect: SourceTreeElementRect;
	isVisible?: string; // "0" or "1"
	children?: Array<SourceTreeElement>;
}

export interface SourceTree {
	value: SourceTreeElement;
}

// farm fork (#1590): EVERY WebDriverAgent call is BOUNDED. Upstream 0.0.60 has NO
// timeout on any fetch, so a wedged WDA (dead RSD tunnel / hung testmanagerd) makes
// tap/screenshot/list-elements hang until the CALLER's timeout fires — the ~13s
// class the farm saw. `wdaFetch` aborts every request after the resolved timeout.
// Read at CALL time so `MOBILEMCP_WDA_TIMEOUT_MS` can be tuned live.
export const wdaTimeoutMs = (): number => {
	const raw = Number.parseInt(process.env.MOBILEMCP_WDA_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(raw) && raw >= 500 && raw <= 120_000 ? raw : 15_000;
};

// A bounded fetch — never hangs. Resolves the Response or throws a clear
// timeout/transport error (the caller surfaces it as an ActionableError).
const wdaFetch = async (url: string, init?: RequestInit, timeoutMs = wdaTimeoutMs()): Promise<Response> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (error: any) {
		if (error?.name === "AbortError") {
			throw new ActionableError(`WebDriverAgent request timed out after ${timeoutMs}ms (${url}). The device control tunnel may be wedged — unplug and replug the iPhone, or restart the tunnel.`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
};

// farm fork (#1590): widen the element filter so container/list/tab/link types are
// tappable. Upstream 0.0.60 only kept TextField/Button/Switch/Icon/SearchField/
// StaticText/Image, so a Tab-bar item exposed as Other/Cell/Link (e.g. the App Store
// "Search" tab) was DROPPED and `find_and_tap` couldn't resolve it → the caller fell
// back to a blind coordinate tap. These are the accessibility types XCUITest reports
// for real, tappable controls.
const ACCEPTED_ELEMENT_TYPES = new Set<string>([
	"TextField", "SecureTextField", "SearchField",
	"Button", "Switch", "Icon", "StaticText", "Image", "Link",
	"Cell", "Other", "Slider", "SegmentedControl", "Tab", "TabBar",
	"MenuItem", "MenuButton", "Key", "Keyboard",
	"DatePicker", "Picker", "PickerWheel", "Stepper", "Toggle", "CheckBox",
]);

export class WebDriverAgent {

	// farm fork (#1590): ONE WDA session per device, cached across actions. Upstream
	// created + deleted a session on EVERY tap/swipe/keys (a full round-trip each),
	// which cost the farm ~557ms/action. We create once, reuse, and re-create exactly
	// once on a "session not found" (WDA restarted).
	private sessionId: string | null = null;

	constructor(private readonly host: string, private readonly port: number) {
	}

	private get baseUrl(): string {
		return `http://${this.host}:${this.port}`;
	}

	public async isRunning(): Promise<boolean> {
		const url = `${this.baseUrl}/status`;
		try {
			const response = await wdaFetch(url, {}, 5_000);
			const json = await response.json();
			return response.status === 200 && json.value?.ready === true;
		} catch (error) {
			// console.error(`Failed to connect to WebDriverAgent: ${error}`);
			return false;
		}
	}

	public async createSession(): Promise<string> {
		const url = `${this.baseUrl}/session`;
		const response = await wdaFetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ capabilities: { alwaysMatch: { platformName: "iOS" } } }),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new ActionableError(`Failed to create WebDriver session: ${response.status} ${errorText}`);
		}

		const json = await response.json();
		if (!json.value || !json.value.sessionId) {
			throw new ActionableError(`Invalid session response: ${JSON.stringify(json)}`);
		}

		// farm fork (#1590): turn OFF WDA idle-waiting once per session. WDA otherwise
		// blocks each command until the UI is quiescent (~557ms/action on a busy app).
		// Best-effort — a WDA that doesn't support the endpoint is fine.
		const sessionId = json.value.sessionId as string;
		try {
			await wdaFetch(`${this.baseUrl}/session/${sessionId}/appium/settings`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ settings: { waitForIdleTimeout: 0, animationCoolOffTimeout: 0 } }),
			}, 4_000);
		} catch {
			// ignore — quiescence tuning is an optimization, not a requirement
		}

		return sessionId;
	}

	public async deleteSession(sessionId: string) {
		const url = `${this.baseUrl}/session/${sessionId}`;
		const response = await wdaFetch(url, { method: "DELETE" });
		return response.json();
	}

	// The cached session URL (create-once). Callers use `withSession` which
	// transparently re-creates on a stale session.
	private async getSessionUrl(): Promise<string> {
		if (!this.sessionId) {
			this.sessionId = await this.createSession();
		}
		return `${this.baseUrl}/session/${this.sessionId}`;
	}

	// Run `fn` against the cached session; on a "session not found"/404 (WDA was
	// restarted) invalidate + re-create the session and retry EXACTLY once. This
	// replaces upstream's create+delete-per-action `withinSession`.
	private async withSession<T>(fn: (sessionUrl: string) => Promise<T>): Promise<T> {
		try {
			return await fn(await this.getSessionUrl());
		} catch (error: any) {
			const msg = String(error?.message ?? error);
			if (/session/i.test(msg) && /(not found|does not exist|invalid|terminated|deleted|404)/i.test(msg)) {
				this.sessionId = null;
				return await fn(await this.getSessionUrl());
			}
			throw error;
		}
	}

	// Back-compat alias kept for any external caller: now session-CACHED (no
	// per-call create/delete). Behaviour is identical to callers.
	public async withinSession<T>(fn: (url: string) => Promise<T>): Promise<T> {
		return this.withSession(fn);
	}

	public async getScreenSize(sessionUrl?: string): Promise<ScreenSize> {
		const read = async (base: string): Promise<ScreenSize> => {
			const response = await wdaFetch(`${base}/wda/screen`);
			const json = await response.json();
			return {
				width: json.value.screenSize.width,
				height: json.value.screenSize.height,
				scale: json.value.scale || 1,
			};
		};
		return sessionUrl ? read(sessionUrl) : this.withSession(read);
	}

	public async sendKeys(keys: string) {
		await this.withSession(async sessionUrl => {
			const url = `${sessionUrl}/wda/keys`;
			await wdaFetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ value: [keys] }),
			});
		});
	}

	public async pressButton(button: string) {
		const _map = {
			"HOME": "home",
			"VOLUME_UP": "volumeup",
			"VOLUME_DOWN": "volumedown",
		};

		if (button === "ENTER") {
			await this.sendKeys("\n");
			return;
		}

		// Type assertion to check if button is a key of _map
		if (!(button in _map)) {
			throw new ActionableError(`Button "${button}" is not supported`);
		}

		await this.withSession(async sessionUrl => {
			const url = `${sessionUrl}/wda/pressButton`;
			const response = await wdaFetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: button,
				}),
			});

			return response.json();
		});
	}

	public async tap(x: number, y: number) {
		await this.withSession(async sessionUrl => {
			const url = `${sessionUrl}/actions`;
			await wdaFetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					actions: [
						{
							type: "pointer",
							id: "finger1",
							parameters: { pointerType: "touch" },
							actions: [
								{ type: "pointerMove", duration: 0, x, y },
								{ type: "pointerDown", button: 0 },
								{ type: "pause", duration: 100 },
								{ type: "pointerUp", button: 0 }
							]
						}
					]
				}),
			});
		});
	}

	public async doubleTap(x: number, y: number) {
		await this.withSession(async sessionUrl => {
			const url = `${sessionUrl}/actions`;
			await wdaFetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					actions: [
						{
							type: "pointer",
							id: "finger1",
							parameters: { pointerType: "touch" },
							actions: [
								{ type: "pointerMove", duration: 0, x, y },
								{ type: "pointerDown", button: 0 },
								{ type: "pause", duration: 50 },
								{ type: "pointerUp", button: 0 },

								{ type: "pause", duration: 100 },

								{ type: "pointerDown", button: 0 },
								{ type: "pause", duration: 50 },
								{ type: "pointerUp", button: 0 }
							]
						}
					]
				}),
			});
		});
	}

	public async longPress(x: number, y: number, duration: number) {
		await this.withSession(async sessionUrl => {
			const url = `${sessionUrl}/actions`;
			await wdaFetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					actions: [
						{
							type: "pointer",
							id: "finger1",
							parameters: { pointerType: "touch" },
							actions: [
								{ type: "pointerMove", duration: 0, x, y },
								{ type: "pointerDown", button: 0 },
								{ type: "pause", duration },
								{ type: "pointerUp", button: 0 }
							]
						}
					]
				}),
			});
		});
	}

	// farm fork (#1590): reject NON-tappable rects. Upstream only checked x>=0 && y>=0,
	// so a zero-size / collapsed element passed the filter and `find_and_tap` could
	// resolve to an untappable point. A tappable control has a positive area.
	public isTappableRect(rect: SourceTreeElementRect): boolean {
		return (
			Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
			Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
			rect.x >= 0 && rect.y >= 0 &&
			rect.width > 0 && rect.height > 0
		);
	}

	// farm fork (#1590): a real, resolvable identity. Upstream compared the optional
	// fields to `null`, but they are `undefined` when absent, so `undefined !== null`
	// was ALWAYS true — the guard never fired and label-less noise leaked into the
	// list. Require at least one non-empty label/name/identifier/value so
	// `find_and_tap` matches on something real.
	public static hasIdentity(source: SourceTreeElement): boolean {
		const nonEmpty = (s?: string): boolean => typeof s === "string" && s.trim().length > 0;
		return nonEmpty(source.label) || nonEmpty(source.name) || nonEmpty(source.rawIdentifier) || nonEmpty(source.value);
	}

	public filterSourceElements(source: SourceTreeElement): Array<ScreenElement> {
		const output: ScreenElement[] = [];

		if (ACCEPTED_ELEMENT_TYPES.has(source.type)) {
			if (source.isVisible === "1" && this.isTappableRect(source.rect) && WebDriverAgent.hasIdentity(source)) {
				output.push({
					type: source.type,
					label: source.label,
					name: source.name,
					value: source.value,
					identifier: source.rawIdentifier,
					rect: {
						x: source.rect.x,
						y: source.rect.y,
						width: source.rect.width,
						height: source.rect.height,
					},
				});
			}
		}

		if (source.children) {
			for (const child of source.children) {
				output.push(...this.filterSourceElements(child));
			}
		}

		return output;
	}

	public async getPageSource(): Promise<SourceTree> {
		const url = `${this.baseUrl}/source/?format=json`;
		const response = await wdaFetch(url);
		const json = await response.json();
		return json as SourceTree;
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		const source = await this.getPageSource();
		return this.filterSourceElements(source.value);
	}

	public async openUrl(url: string): Promise<void> {
		await this.withSession(async sessionUrl => {
			await wdaFetch(`${sessionUrl}/url`, {
				method: "POST",
				body: JSON.stringify({ url }),
			});
		});
	}

	public async getScreenshot(): Promise<Buffer> {
		const url = `${this.baseUrl}/screenshot`;
		// farm fork (#1590): bounded so a wedged control tunnel can't hang the
		// screenshot for the whole caller timeout (the ~13s class).
		const response = await wdaFetch(url, {}, wdaTimeoutMs());
		const json = await response.json();
		return Buffer.from(json.value, "base64");
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		await this.withSession(async sessionUrl => {
			const screenSize = await this.getScreenSize(sessionUrl);
			let x0: number, y0: number, x1: number, y1: number;
			// Use 60% of the width/height for swipe distance
			const verticalDistance = Math.floor(screenSize.height * 0.6);
			const horizontalDistance = Math.floor(screenSize.width * 0.6);
			const centerX = Math.floor(screenSize.width / 2);
			const centerY = Math.floor(screenSize.height / 2);

			switch (direction) {
				case "up":
					x0 = x1 = centerX;
					y0 = centerY + Math.floor(verticalDistance / 2);
					y1 = centerY - Math.floor(verticalDistance / 2);
					break;
				case "down":
					x0 = x1 = centerX;
					y0 = centerY - Math.floor(verticalDistance / 2);
					y1 = centerY + Math.floor(verticalDistance / 2);
					break;
				case "left":
					y0 = y1 = centerY;
					x0 = centerX + Math.floor(horizontalDistance / 2);
					x1 = centerX - Math.floor(horizontalDistance / 2);
					break;
				case "right":
					y0 = y1 = centerY;
					x0 = centerX - Math.floor(horizontalDistance / 2);
					x1 = centerX + Math.floor(horizontalDistance / 2);
					break;
				default:
					throw new ActionableError(`Swipe direction "${direction}" is not supported`);
			}

			const url = `${sessionUrl}/actions`;
			const response = await wdaFetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					actions: [
						{
							type: "pointer",
							id: "finger1",
							parameters: { pointerType: "touch" },
							actions: [
								{ type: "pointerMove", duration: 0, x: x0, y: y0 },
								{ type: "pointerDown", button: 0 },
								{ type: "pointerMove", duration: 1000, x: x1, y: y1 },
								{ type: "pointerUp", button: 0 }
							]
						}
					]
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new ActionableError(`WebDriver actions request failed: ${response.status} ${errorText}`);
			}

			// Clear actions to ensure they complete
			await wdaFetch(`${sessionUrl}/actions`, {
				method: "DELETE",
			});
		});
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance: number = 400): Promise<void> {
		await this.withSession(async sessionUrl => {
			// Use simple coordinates like the working swipe method
			const x0 = x;
			const y0 = y;
			let x1 = x;
			let y1 = y;

			// Calculate target position based on direction and distance
			switch (direction) {
				case "up":
					y1 = y - distance; // Move up by specified distance
					break;
				case "down":
					y1 = y + distance; // Move down by specified distance
					break;
				case "left":
					x1 = x - distance; // Move left by specified distance
					break;
				case "right":
					x1 = x + distance; // Move right by specified distance
					break;
				default:
					throw new ActionableError(`Swipe direction "${direction}" is not supported`);
			}

			const url = `${sessionUrl}/actions`;
			const response = await wdaFetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					actions: [
						{
							type: "pointer",
							id: "finger1",
							parameters: { pointerType: "touch" },
							actions: [
								{ type: "pointerMove", duration: 0, x: x0, y: y0 },
								{ type: "pointerDown", button: 0 },
								{ type: "pointerMove", duration: 1000, x: x1, y: y1 },
								{ type: "pointerUp", button: 0 }
							]
						}
					]
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new ActionableError(`WebDriver actions request failed: ${response.status} ${errorText}`);
			}

			// Clear actions to ensure they complete
			await wdaFetch(`${sessionUrl}/actions`, {
				method: "DELETE",
			});
		});
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		await this.withSession(async sessionUrl => {
			const url = `${sessionUrl}/orientation`;
			await wdaFetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					orientation: orientation.toUpperCase()
				})
			});
		});
	}

	public async getOrientation(): Promise<Orientation> {
		return this.withSession(async sessionUrl => {
			const url = `${sessionUrl}/orientation`;
			const response = await wdaFetch(url);
			const json = await response.json();
			return json.value.toLowerCase() as Orientation;
		});
	}
}
