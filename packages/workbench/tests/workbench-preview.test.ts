import { describe, expect, it } from "vitest";
import { previewDocument, previewUrl, previewPageUrl, isHostLocalPreview, previewStartRefused } from "../app/lib/workbench-preview";

describe("workbench previews", () => {
  it("resolves workspace links using the active origin", () => {
    expect(previewUrl("/design", "https://workspace.example")).toBe("https://workspace.example/design");
  });

  it.each(["javascript:alert(1)", "data:text/html,test", "file:///example.html", "https://user:password@example.com"])("rejects unsafe address %s", (value) => {
    expect(() => previewUrl(value, "https://workspace.example")).toThrow();
  });

  it("puts a restrictive policy before generated content", () => {
    const output = previewDocument("<script>fetch('/private')</script>");
    expect(output.indexOf("Content-Security-Policy")).toBeLessThan(output.indexOf("<script>"));
    expect(output).toContain("connect-src 'none'");
    expect(output).toContain("form-action 'none'");
    expect(output).not.toContain("script-src 'unsafe-inline' https:");
  });
});


describe("host-local preview addresses", () => {
  it.each([
    "http://127.0.0.1:5173/", "http://127.1/", "http://localhost./",
    "http://app.localhost/", "http://[::1]/", "http://[::]/",
    "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/",
  ])("requires host confirmation before navigating %s", value => {
    expect(isHostLocalPreview(previewUrl(value, "https://vivary.example"))).toBe(true);
  });
  it.each(["https://preview.example/", "https://127.example.com/", "https://localhost.example/"])(
    "does not mislabel an external address %s", value => {
      expect(isHostLocalPreview(value)).toBe(false);
    },
  );
});


describe("running preview origins", () => {
  it.each(["/files", "http://127.0.0.1:55173/", "http://127.0.0.1:55173/_agent-native/actions"])(
    "does not embed the application origin through %s", value => {
      expect(() => previewPageUrl(value, "http://127.0.0.1:55173")).toThrow("project's preview address");
    },
  );
  it("normalizes default ports before comparing origins", () => {
    expect(() => previewPageUrl("http://vivary.example:80/", "http://vivary.example")).toThrow();
  });
  it("permits the separately hosted project", () => {
    expect(previewPageUrl("http://127.0.0.1:5173/", "http://127.0.0.1:55173")).toBe("http://127.0.0.1:5173/");
  });
});


describe("preview start recovery", () => {
  it("allows a fresh review after an explicit Native refusal", () => {
    expect(previewStartRefused(Object.assign(new Error("Review again."), {
      status: 409, errorCode: "vivary_project_preview_refused",
    }))).toBe(true);
  });
  it.each([400, 403, 404, 422])("allows a fresh review after authored pre-launch HTTP %s", status => {
    expect(previewStartRefused(Object.assign(new Error("Project folder access changed."), {
      status, actionMessage: "Project folder access changed.",
    }))).toBe(true);
  });
  it.each([
    new Error("Connection lost"),
    Object.assign(new Error("Timeout"), { status: 408 }),
    Object.assign(new Error("Unreadable response"), { status: 200 }),
    Object.assign(new Error("Sign in"), { status: 401, actionMessage: "Sign in" }),
    Object.assign(new Error("Busy"), { status: 429, actionMessage: "Rate limited" }),
    Object.assign(new Error("Unreadable forbidden response"), { status: 403 }),
    Object.assign(new Error("Empty forbidden response"), { status: 403, actionMessage: "" }),
    Object.assign(new Error("Proxy response"), { status: 409 }),
    Object.assign(new Error("Server failed"), { status: 500, errorCode: "vivary_project_preview_refused" }),
  ])("retains the request when completion is uncertain: %s", error => {
    expect(previewStartRefused(error)).toBe(false);
  });
});
