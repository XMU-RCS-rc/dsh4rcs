/**
 * 真实的外部命令执行器。
 *
 * 单独成文件是因为它是 `rcs-core` 里**唯一**会 spawn 子进程的地方 ——
 * 其余全是纯函数。想知道这套工具会在你机器上跑什么，看这一个文件就够。
 *
 * 三条约束：
 *   1. **不过 shell。** `spawn` 直接传 argv，不拼命令行字符串 ——
 *      工程路径里带空格、带中文（队内真有「硬件/软件培训知识体系」这种名字）
 *      在 shell 拼接下会被切碎，更别说注入风险。
 *   2. **必须有超时。** 烧录器没插、Keil 弹了个模态框，进程会永远挂着。
 *      超时就杀掉并如实说是超时，而不是让调用方干等。
 *   3. **不抛异常。** 命令跑不起来（ENOENT 等）也返回结构化结果，
 *      让上层统一按「工具链缺失」处理。
 */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import type { CommandResult, CommandRunner, ProbeDeps } from './toolchain.ts'

/** 输出截断上限。构建日志可能上兆，全塞进模型上下文既贵又没用。 */
const MAX_OUTPUT = 256 * 1024

export const nodeRunner: CommandRunner = (command, args, options = {}) =>
  new Promise<CommandResult>((resolve) => {
    const timeoutMs = options.timeoutMs ?? 2 * 60 * 1000
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (r: CommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }

    let child: ReturnType<typeof spawn>
    try {
      // shell: false —— 路径里的空格与中文交给 argv，不交给 shell
      child = spawn(command, args, { cwd: options.cwd, shell: false, windowsHide: true })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: '', spawnError: (e as Error).message })
      return
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({
        code: -1,
        stdout,
        stderr,
        spawnError: `超时（${Math.round(timeoutMs / 1000)}s）已强制结束。常见原因：烧录器未连接、Keil 弹出了模态对话框。`,
      })
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString()
    })
    child.on('error', (e) => finish({ code: -1, stdout, stderr, spawnError: e.message }))
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
  })

/** Windows 下可执行文件的后缀。 */
const EXE_EXT = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']

/**
 * 判断一个路径上是否存在可执行文件。
 *
 * `existsSync` 单独用是不够的：Windows 的**应用执行别名**
 * （`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` 这类）是零字节的
 * `IO_REPARSE_TAG_APPEXECLINK` 重解析点，`stat` 解析不了它，`existsSync`
 * 因此返回 false —— 于是装了 Microsoft Store 版 Python 的机器会被误报成
 * 「没有 Python」。`lstatSync` 不跟随重解析点，能正确看到这个条目。
 *
 * 实测：本机 PATH 里有 WindowsApps、`python` 可正常调用，但 `existsSync`
 * 返回 false。这是加 `lstatSync` 兜底的直接原因。
 */
function executableExists(p: string): boolean {
  if (existsSync(p)) return true
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * 在 PATH 里找可执行文件。
 *
 * 自己实现而不是调 `where`/`which`：那要多起一个进程，且在 Windows 上
 * `where` 的退出码与输出格式都得另做处理。
 */
export function whichSync(cmd: string): string | undefined {
  if (cmd.includes('/') || cmd.includes('\\')) {
    return executableExists(cmd) ? cmd : undefined
  }
  const paths = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  for (const dir of paths) {
    for (const ext of EXE_EXT) {
      const full = join(dir, cmd + ext)
      if (executableExists(full)) return full
    }
  }
  return undefined
}

/** 真实环境的探测依赖。 */
export const nodeDeps: ProbeDeps = {
  exists: (p: string) => existsSync(p),
  which: whichSync,
}
