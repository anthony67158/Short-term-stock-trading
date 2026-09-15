import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";

test("账户资金闭环、刷新、隔离、深浅主题与四视口", async ({ browser, playwright }) => {
  const identity = JSON.parse(execFileSync("uv", [
    "run", "python", "tests/provision_browser.py",
  ], { cwd: "backend", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const auth = await playwright.request.newContext({
    baseURL: "http://localhost:5173", extraHTTPHeaders: { Origin: "http://localhost:5173" },
  });
  let context;
  try {
    // Establish a real, isolated test session without typing or exposing credentials.
    const login = await auth.post("/api/v1/sessions", {
      data: { username: identity.username, password: identity.password },
    });
    expect(login.status()).toBe(200);
    context = await browser.newContext({
      storageState: await auth.storageState(), viewport: { width: 1440, height: 900 },
      timezoneId: "Asia/Shanghai",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("422"))
        errors.push(message.text());
    });
    await page.goto("http://localhost:5173/portfolio");
    await page.getByRole("button", { name: "创建账户", exact: true }).click();
    await page.getByLabel("账户名称").fill("浏览器合成账户");
    await page.getByRole("button", { name: "创建账户", exact: true }).last().click();
    await expect(page.getByText("现金余额 · 人民币")).toBeVisible();
    await page.getByRole("button", { name: "录入资金", exact: true }).click();
    await page.getByLabel("金额（元）", { exact: true }).fill("10000.01");
    const localTime = (offsetMs = 0) => new Date(Date.now() + 8 * 3600_000 + offsetMs).toISOString().slice(0, 19);
    await page.getByLabel("发生时间（留空为当前时间）").fill(localTime(-2 * 86400_000).slice(0, 16));
    await page.getByLabel("凭据或来源说明").fill("合成期初凭据");
    await page.getByRole("button", { name: "保存资金记录" }).click();
    await expect(page.locator(".balance-value")).toHaveText("10,000.01");
    await expect(page.getByText("合成期初凭据", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator(".balance-value")).toHaveText("10,000.01");
    await page.getByRole("button", { name: "录入资金", exact: true }).click();
    await page.getByLabel("资金类型").selectOption("WITHDRAWAL");
    await page.getByLabel("发生时间（留空为当前时间）").fill(localTime(-86400_000).slice(0, 16));
    await page.getByLabel("金额（元）", { exact: true }).fill("20000");
    await page.getByLabel("凭据或来源说明").fill("合成出金凭据");
    await page.getByRole("button", { name: "保存资金记录" }).click();
    await expect(page.getByRole("alert")).toHaveText("出金金额超过现金余额");
    await page.getByLabel("金额（元）", { exact: true }).fill("200.02");
    await page.getByRole("button", { name: "保存资金记录" }).click();
    await expect(page.locator(".balance-value")).toHaveText("9,799.99");
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await page.getByRole("button", { name: "录入成交", exact: true }).click();
    await page.getByLabel("证券代码（6位）").fill("000001");
    await page.getByLabel("实际成交股数").fill("37");
    await page.getByLabel("成交价格（元）").fill("10");
    await page.getByLabel("成交时间", { exact: true }).fill(localTime());
    await page.getByLabel("实际佣金（元）").fill("5");
    await page.getByLabel("实际印花税（元）").fill("0");
    await page.getByLabel("实际过户费（元）").fill("0");
    await page.getByLabel("其他实际费用（元）").fill("0");
    await page.getByLabel("交割编号（账户内唯一）").fill("synthetic-partial-buy-1");
    await page.getByLabel("成交凭据说明").fill("浏览器合成部分成交");
    await page.getByRole("button", { name: "保存成交事实" }).click();
    await expect(page.locator(".balance-value")).toHaveText("9,424.99");
    await expect(page.getByRole("region", { name: "持仓明细，可横向滚动" })).toContainText("37 / 0");
    await page.reload();
    await expect(page.locator(".balance-value")).toHaveText("9,424.99");
    await expect(page.getByRole("region", { name: "持仓明细，可横向滚动" })).toContainText("375.00");
    await page.getByRole("button", { name: "录入成交", exact: true }).click();
    await page.getByLabel("证券代码（6位）").fill("000001");
    await page.getByLabel("成交方向").selectOption("SELL");
    await page.getByLabel("实际成交股数").fill("37");
    await page.getByLabel("成交价格（元）").fill("12");
    await page.getByLabel("成交时间", { exact: true }).fill(localTime());
    await page.getByLabel("实际佣金（元）").fill("5");
    await page.getByLabel("实际印花税（元）").fill("0.22");
    await page.getByLabel("实际过户费（元）").fill("0");
    await page.getByLabel("其他实际费用（元）").fill("0");
    await page.getByLabel("交割编号（账户内唯一）").fill("synthetic-rejected-sale");
    await page.getByLabel("成交凭据说明").fill("合成T+1拒绝场景");
    await page.getByRole("button", { name: "保存成交事实" }).click();
    await expect(page.getByRole("alert")).toContainText("可卖股数不足");
    await expect(page.locator(".balance-value")).toHaveText("9,424.99");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "核对账本", exact: true }).click();
    await expect(page.getByText("账本核对一致", { exact: true })).toBeVisible();
    await expect(page.getByText("已复算 1 笔成交 · 1 个未平批次 · 现金 9424.99 元")).toBeVisible();
    await page.getByRole("button", { name: "冲正", exact: true }).click();
    await page.getByLabel("冲正原因", { exact: true }).fill("合成误录冲正");
    await page.getByRole("button", { name: "预览冲正影响" }).click();
    await expect(page.getByRole("region", { name: "成交冲正", exact: true })).toContainText("9424.99 → 9799.99");
    await page.screenshot({ path: "test-results/correction-preview.png", fullPage: true });
    await page.getByRole("button", { name: "确认冲正这笔成交" }).click();
    await expect(page.getByText("成交已冲正，持仓与现金已更新，原始凭据已保留。")).toBeVisible();
    await expect(page.locator(".balance-value")).toHaveText("9,799.99");
    await page.getByRole("button", { name: "关闭冲正结果" }).click();
    await page.reload();
    await expect(page.getByRole("region", { name: "成交明细，可横向滚动" })).toContainText("已冲正");
    await expect(page.getByRole("region", { name: "冲正记录，可横向滚动" })).toContainText("合成误录冲正");
    await expect(page.getByRole("heading", { name: "尚无持仓", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "核对账本", exact: true }).click();
    await expect(page.getByText("账本核对一致", { exact: true })).toBeVisible();
    await expect(page.getByText("已复算 1 笔成交 · 0 个未平批次 · 现金 9799.99 元")).toBeVisible();
    const importCsv = [
      "instrumentId,sourceKey,side,quantityShares,price,executedAt,commission,stampTax,transferFee,otherFee,source",
      `SZ.000001,synthetic-csv-buy,BUY,37,10,${localTime()}+08:00,5,0,0,0,合成CSV交割`,
    ].join("\n");
    await page.getByLabel("交割单文件（UTF-8 CSV）").setInputFiles({
      name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(importCsv),
    });
    await page.getByRole("button", { name: "预览交割单", exact: true }).click();
    await expect(page.getByRole("region", { name: "交割单预览，可横向滚动" })).toContainText("待入账");
    await expect(page.locator(".balance-value")).toHaveText("9,799.99");
    await page.reload();
    await expect(page.getByRole("region", { name: "交割单预览，可横向滚动" })).toContainText("synthetic-csv-buy");
    await page.getByRole("button", { name: "确认导入全部有效成交" }).click();
    await expect(page.getByText("交割单已入账，重复记录已跳过。")).toBeVisible();
    await expect(page.locator(".balance-value")).toHaveText("9,424.99");
    await page.getByLabel("交割单文件（UTF-8 CSV）").setInputFiles({
      name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(importCsv),
    });
    await page.getByRole("button", { name: "预览交割单", exact: true }).click();
    await expect(page.getByRole("region", { name: "交割单预览，可横向滚动" })).toContainText("重复，跳过");
    await page.getByRole("button", { name: "确认导入全部有效成交" }).click();
    await expect(page.getByText("交割单已入账，重复记录已跳过。")).toBeVisible();
    await expect(page.locator(".balance-value")).toHaveText("9,424.99");
    await page.getByRole("button", { name: "核对账本", exact: true }).click();
    await expect(page.getByText("账本核对一致", { exact: true })).toBeVisible();
    await expect(page.getByText("已复算 2 笔成交 · 1 个未平批次 · 现金 9424.99 元")).toBeVisible();
    await page.getByRole("button", { name: "创建人工计划", exact: true }).click();
    await page.getByLabel("计划证券代码").fill("000001");
    await page.getByLabel("计划股数", { exact: true }).fill("100");
    await page.getByLabel("计划限价（元）").fill("10");
    await page.getByLabel("费用预留预算（元）").fill("5");
    await page.getByLabel("计划到期时间（本设备时区，当日内）").fill(localTime(10 * 60_000));
    await page.getByLabel("计划依据", { exact: true }).fill("合成现金预留验收");
    await page.getByRole("button", { name: "确认人工计划并预留" }).click();
    await expect(page.getByText("计划已确认，现金与持仓事实未改变。")).toBeVisible();
    await expect(page.getByText("计划预留：1005.00 元 · 可支配现金：8419.99 元")).toBeVisible();
    await expect(page.locator(".balance-value")).toHaveText("9,424.99");
    await page.reload();
    await expect(page.getByRole("region", { name: "人工计划，可横向滚动" })).toContainText("0 / 100");
    const planId = await page.getByRole("region", { name: "人工计划，可横向滚动" })
      .locator("tbody tr").first().locator("td").nth(4).innerText();
    await page.getByRole("button", { name: "录入成交", exact: true }).click();
    await page.getByLabel("证券代码（6位）").fill("000001");
    await page.getByLabel("实际成交股数").fill("37");
    await page.getByLabel("成交价格（元）").fill("10");
    await page.getByLabel("成交时间", { exact: true }).fill(localTime());
    await page.getByLabel("实际佣金（元）").fill("5");
    await page.getByLabel("实际印花税（元）").fill("0");
    await page.getByLabel("实际过户费（元）").fill("0");
    await page.getByLabel("其他实际费用（元）").fill("0");
    await page.getByLabel("交割编号（账户内唯一）").fill("synthetic-linked-partial");
    await page.getByLabel("成交凭据说明").fill("合成关联计划部分成交");
    await page.getByLabel("关联人工计划编号（可选）").fill(planId);
    await page.getByRole("button", { name: "保存成交事实" }).click();
    await expect(page.locator(".balance-value")).toHaveText("9,049.99");
    await expect(page.getByRole("region", { name: "人工计划，可横向滚动" })).toContainText("37 / 100");
    await expect(page.getByText("计划预留：630.00 元 · 可支配现金：8419.99 元")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("region", { name: "人工计划，可横向滚动" })).toContainText("部分成交已记录");
    await page.getByRole("button", { name: "取消计划", exact: true }).click();
    await page.getByLabel("取消计划原因").fill("合成取消预留");
    await page.getByRole("button", { name: "确认取消并释放剩余预留" }).click();
    await expect(page.getByRole("region", { name: "人工计划，可横向滚动" })).toContainText("已取消");
    await expect(page.getByText("计划预留：0 元 · 可支配现金：9049.99 元")).toBeVisible();
    await page.getByRole("button", { name: "核对账本", exact: true }).click();
    await expect(page.getByText("账本核对一致", { exact: true })).toBeVisible();
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await page.getByRole("button", { name: "切换深浅主题" }).click();
      for (const width of [390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await expect(page.locator(".balance-value")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `test-results/cash-${theme}-${width}.png`, fullPage: true });
      }
    }
    expect(errors).toEqual([]);
    await page.getByRole("link", { name: "市场与选股", exact: true }).click();
    await page.getByRole("searchbox", { name: "搜索股票" }).fill("000001");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("link", { name: "平安银行", exact: true }).click();
    await expect(page.getByRole("heading", { name: "行情快照" })).toBeVisible();
    await expect(page.locator(".quote-strip strong").first()).not.toBeEmpty({ timeout: 15_000 });
    await page.getByRole("button", { name: "加入关注", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已加入关注" })).toBeVisible();
    await page.getByRole("link", { name: "返回市场" }).click();
    await page.getByRole("button", { name: "我的关注" }).click();
    await expect(page.getByRole("link", { name: "平安银行", exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "我的关注" }).click();
    await page.getByRole("link", { name: "平安银行", exact: true }).click();
    await page.getByRole("button", { name: "移出关注", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已移出关注" })).toBeVisible();
    await page.getByRole("button", { name: "添加研究材料" }).click();
    await page.getByLabel("材料标题").fill("合成浏览器研究材料");
    await page.getByLabel("原文链接（HTTPS）").fill("https://example.com/synthetic-evidence");
    await page.getByLabel("原文发布时间").fill("2026-09-14T10:00");
    await page.getByLabel("原文内容", { exact: true }).fill("这是用于浏览器验收的合成材料。订单需要进一步核验，不代表任何真实公司信息。");
    await page.getByLabel("引用片段（须与原文一致）").fill("订单需要进一步核验，不代表任何真实公司信息。");
    await page.getByRole("button", { name: "保存材料", exact: true }).click();
    await expect(page.locator("summary").filter({ hasText: "合成浏览器研究材料" })).toBeVisible();
    await page.reload();
    await page.locator("summary").filter({ hasText: "合成浏览器研究材料" }).click();
    await expect(page.getByRole("blockquote")).toContainText("订单需要进一步核验");
    await page.getByLabel("用于本次研究").check();
    await expect(page.getByRole("button", { name: "开始证据研究" })).toBeDisabled();
    await expect(page.getByText("研究推理服务尚未启用；请先完成供应商鉴权验证")).toBeVisible();
    expect(errors).toEqual([]);
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByRole("button", { name: "登录工作区" })).toBeVisible();
    await expect(page.getByText("合成期初凭据", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "登录工作区" })).toBeVisible();
  } finally {
    await context?.close();
    await auth.dispose();
    execFileSync("uv", ["run", "python", "tests/provision_browser.py", identity.userId], {
      cwd: "backend", stdio: ["ignore", "pipe", "pipe"],
    });
  }
});
