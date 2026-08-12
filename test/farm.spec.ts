import { test, expect } from "@playwright/test";
import { createServer, Server } from "node:http";

import { WebDriverAgent, SourceTreeElement } from "../src/webdriver-agent";
import { resolveWdaEndpoint } from "../src/ios";

// farm fork (#1590) device-free unit tests: element-query accuracy, per-device WDA
// endpoint (no cross-wire), and the bounded fetch (no ~13s hang). No device / no WDA.

const el = (type: string, over: Partial<SourceTreeElement> = {}): SourceTreeElement => ({
	type,
	rect: { x: 10, y: 10, width: 40, height: 40 },
	isVisible: "1",
	label: "x",
	...over,
});

test("filterSourceElements returns the widened tappable types (App Store Search-tab class)", () => {
	const wda = new WebDriverAgent("localhost", 8100);
	// A TabBar whose "Search" tab is exposed as an Other/Cell/Button — the exact class
	// upstream 0.0.60 DROPPED (only Button/TextField/… were accepted), forcing the
	// caller to a blind coordinate tap.
	const tree: SourceTreeElement = {
		type: "Application",
		rect: { x: 0, y: 0, width: 390, height: 844 },
		children: [
			{
				type: "TabBar",
				rect: { x: 0, y: 790, width: 390, height: 54 },
				isVisible: "1",
				children: [
					el("Other", { label: "Search", name: "Search", rect: { x: 200, y: 795, width: 60, height: 44 } }),
					el("Cell", { label: undefined, name: "Apps", rect: { x: 80, y: 795, width: 60, height: 44 } }),
					el("Button", { label: "Today", rect: { x: 10, y: 795, width: 60, height: 44 } }),
					el("Link", { label: "Terms", rect: { x: 300, y: 795, width: 60, height: 44 } }),
				],
			},
		],
	};
	const found = wda.filterSourceElements(tree);
	const labels = found.map(e => e.label ?? e.name);
	expect(labels).toContain("Search"); // the RED case: an `Other`-typed tab
	expect(labels).toContain("Apps");   // a `Cell`
	expect(labels).toContain("Today");  // a `Button` (kept in upstream too)
	expect(labels).toContain("Terms");  // a `Link`
});

test("isTappableRect rejects zero-area / negative / non-finite rects", () => {
	const wda = new WebDriverAgent("localhost", 8100);
	expect(wda.isTappableRect({ x: 10, y: 10, width: 40, height: 40 })).toBe(true);
	expect(wda.isTappableRect({ x: 10, y: 10, width: 0, height: 40 })).toBe(false); // collapsed
	expect(wda.isTappableRect({ x: 10, y: 10, width: 40, height: 0 })).toBe(false);
	expect(wda.isTappableRect({ x: -1, y: 10, width: 40, height: 40 })).toBe(false); // off-screen
	expect(wda.isTappableRect({ x: NaN, y: 10, width: 40, height: 40 })).toBe(false);
});

test("hasIdentity requires a non-empty label/name/identifier/value", () => {
	expect(WebDriverAgent.hasIdentity(el("Button", { label: undefined, name: undefined, rawIdentifier: undefined, value: undefined }))).toBe(false);
	expect(WebDriverAgent.hasIdentity(el("Button", { label: "  ", name: undefined, rawIdentifier: undefined, value: undefined }))).toBe(false);
	expect(WebDriverAgent.hasIdentity(el("Button", { label: undefined, name: "Go", rawIdentifier: undefined, value: undefined }))).toBe(true);
	expect(WebDriverAgent.hasIdentity(el("Button", { label: undefined, name: undefined, rawIdentifier: "id-1", value: undefined }))).toBe(true);
});

test("a label-less, zero-area, or off-screen element is filtered out", () => {
	const wda = new WebDriverAgent("localhost", 8100);
	const tree: SourceTreeElement = {
		type: "Application",
		rect: { x: 0, y: 0, width: 390, height: 844 },
		children: [
			el("Button", { label: undefined, name: undefined, rawIdentifier: undefined, value: undefined }), // no identity
			el("Button", { label: "Zero", rect: { x: 5, y: 5, width: 0, height: 20 } }), // zero-area
			el("Button", { label: "Good", rect: { x: 5, y: 5, width: 30, height: 20 } }), // kept
			el("Button", { label: "Hidden", isVisible: "0" }), // isVisible=0
		],
	};
	const found = wda.filterSourceElements(tree).map(e => e.label);
	expect(found).toEqual(["Good"]);
});

test("resolveWdaEndpoint gives DISTINCT per-device ports (no 8100 cross-wire)", () => {
	const A = "00008030-AAAA";
	const B = "00008030-BBBB";
	process.env.MOBILEMCP_WDA_PORTS = `${A}=8201,${B}=8202`;
	try {
		expect(resolveWdaEndpoint(A).port).toBe(8201);
		expect(resolveWdaEndpoint(B).port).toBe(8202);
		// the RED case the fixed WDA_PORT=8100 would have produced: A and B share a port.
		expect(resolveWdaEndpoint(A).port).not.toBe(resolveWdaEndpoint(B).port);
	} finally {
		delete process.env.MOBILEMCP_WDA_PORTS;
	}
});

test("resolveWdaEndpoint honors a single override and defaults to 8100", () => {
	const D = "udid-x";
	process.env.MOBILEMCP_WDA_PORT = "8299";
	try {
		expect(resolveWdaEndpoint(D).port).toBe(8299);
	} finally {
		delete process.env.MOBILEMCP_WDA_PORT;
	}
	expect(resolveWdaEndpoint(D).port).toBe(8100); // default
	expect(resolveWdaEndpoint(D).host).toBe("localhost");
});

test("every WDA fetch is BOUNDED — a never-responding WDA throws a timeout, does not hang", async () => {
	// A server that ACCEPTS the connection then never replies — the exact wedge that
	// upstream 0.0.60 (no fetch timeout) would hang on until the caller's timeout.
	const server: Server = createServer(() => { /* never respond */ });
	await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
	const port = (server.address() as any).port;
	process.env.MOBILEMCP_WDA_TIMEOUT_MS = "800";
	try {
		const wda = new WebDriverAgent("127.0.0.1", port);
		const started = Date.now();
		let threw: Error | null = null;
		try {
			await wda.getScreenshot();
		} catch (e: any) {
			threw = e;
		}
		const elapsed = Date.now() - started;
		expect(threw, "getScreenshot must reject on a wedged WDA, not hang").not.toBeNull();
		expect(String(threw?.message)).toMatch(/timed out after 800ms/i);
		expect(elapsed).toBeGreaterThanOrEqual(700);
		expect(elapsed).toBeLessThan(4000); // bounded — NOT the multi-second/forever hang
	} finally {
		delete process.env.MOBILEMCP_WDA_TIMEOUT_MS;
		await new Promise<void>(r => server.close(() => r()));
	}
});
