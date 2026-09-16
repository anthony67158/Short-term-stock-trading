import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";

test("今日、策略与复盘工作区在部署端可恢复", async ({ browser, playwright }) => {
  const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
  const identity = JSON.parse(execFileSync(
    "uv",
    ["run", "python", "tests/provision_browser.py"],
    {
      cwd: "backend",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ));
  const auth = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL },
  });
  let context;
  try {
    expect((await auth.post("/api/v1/sessions", {
      data: {
        username: identity.username,
        password: identity.password,
      },
    })).status()).toBe(200);
    context = await browser.newContext({
      storageState: await auth.storageState(),
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(baseURL);
    await expect(page.getByRole("heading", { name: "今日工作台" })).toBeVisible();
    await expect(page.getByText("活动联合包", { exact: true })).toBeVisible();
    await expect(page.getByText(/joint-shadow-/)).toBeVisible();
    await page.getByRole("link", { name: "策略实验室", exact: true }).click();
    await expect(page.getByRole("heading", { name: "策略实验室" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "策略版本" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("tab", { name: "实验对比" }).click();
    await expect(page.getByRole("heading", { name: "尚无实验" })).toBeVisible();
    await page.getByRole("tab", { name: "发布历史" }).click();
    await expect(page.getByText("SHADOW · 不允许真实账户新增风险")).toBeVisible();
    await page.getByRole("link", { name: "复盘与洞察", exact: true }).click();
    await expect(page.getByRole("heading", { name: "复盘与洞察" })).toBeVisible();
    await expect(page.getByText("尚无复盘记录")).toBeVisible();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({
        width,
        height: width === 390 ? 844 : 900,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/workspace-${width}.png`,
        fullPage: true,
      });
    }
    await page.getByRole("button", { name: "切换深浅主题" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await auth.dispose();
    execFileSync(
      "uv",
      ["run", "python", "tests/provision_browser.py", identity.userId],
      { cwd: "backend", stdio: ["ignore", "pipe", "pipe"] },
    );
  }
});
