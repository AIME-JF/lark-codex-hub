import { describe, expect, it } from "vitest";
import { renderServiceLaunchers } from "../src/adapters/windows/scheduled-task.js";

describe("Windows 静默启动脚本", () => {
  it("保留中文路径并通过隐藏窗口启动", () => {
    const output = renderServiceLaunchers({
      home: "C:\\Users\\测试用户\\.lark-codex-hub",
      installRoot: "D:\\桌面\\VUE\\lark-codex-hub",
      cliFile: "D:\\桌面\\VUE\\lark-codex-hub\\dist\\cli\\index.js",
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe"
    });
    expect(output.runner).toContain("D:\\桌面\\VUE\\lark-codex-hub");
    expect(output.runner).toContain("[System.Text.UTF8Encoding]");
    expect(output.vbs).toContain("shell.Run");
    expect(output.vbs).toContain(", 0, True");
    expect(output.vbs).toContain("-WindowStyle Hidden");
    expect(output.runner).toContain("$ErrorActionPreference = 'Continue'");
    expect(output.runner).toContain("$serviceExitCode = $LASTEXITCODE");
    expect(output.vbs).toContain("WScript.Quit exitCode");
  });
});
