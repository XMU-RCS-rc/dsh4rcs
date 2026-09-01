/**
 * 嵌入式代码规范检查。
 *
 * ## 为什么值得做规则化检查而不是让模型自由 review
 *
 * 新人在嵌入式上犯的错**是固定的那几类**：中断里调阻塞函数、忘了 volatile、
 * 临界区没配对、DMA 缓冲区没对齐。规则化检查比模型自由发挥更可靠（不会漏、
 * 不会编）、更便宜（不烧 token）、更可复现（同样的代码永远同样的结论）。
 *
 * ## 与本届规则的关联
 *
 * 规则 12.2 强制要求「清晰可见且易于触及的红色急停按钮」。这里有一条专门的检查：
 * **急停回路是否可能被软件旁路** —— 如果代码里存在把急停信号当普通 GPIO 读、
 * 再由软件决定要不要停的写法，那急停就不是硬件回路了。
 * 模板 README 的原话也是这个意思：「软件停止不能替代硬件急停、驱动使能线和限位保护」。
 *
 * ## 定位
 *
 * 这是**启发式**检查，会有误报。所以：
 *   - 每条 finding 都说明「为什么这样写有问题」，而不只是报个位置；
 *   - 支持用 `// rcs-lint-ignore: <ruleId>` 就地豁免，并要求写理由。
 */
import type { CheckResult, Finding, Severity } from './types.ts'
import { toResult } from './types.ts'
import { walkFiles, readText, relPath } from './fsutil.ts'

export type EmbeddedRule = {
  id: string
  severity: Severity
  /** 在**函数体**里匹配的正则（逐行）。 */
  pattern: string
  message: string
  /** 为什么这样写有问题。 */
  why: string
  /** 只在中断服务函数里检查。 */
  isrOnly?: boolean
  /** 只在文件作用域（函数体外）检查。 */
  fileScopeOnly?: boolean
  /** 仅当本文件里存在中断服务函数时才检查。 */
  requiresIsrInFile?: boolean
}

/**
 * 默认规则集。
 *
 * 全部来自嵌入式领域的通用共识，不依赖 RCS 队内参数，所以现在就能用。
 */
export const DEFAULT_EMBEDDED_RULES: EmbeddedRule[] = [
  {
    id: 'isr-no-printf',
    severity: 'error',
    pattern: String.raw`\b(printf|sprintf|snprintf|puts|fprintf)\s*\(`,
    isrOnly: true,
    message: '中断里调用了 printf 系列',
    why: 'printf 会走格式化与阻塞输出，在中断里可能耗时数毫秒，直接打乱控制周期，严重时丢中断。要输出请置标志位，交给任务处理。',
  },
  {
    id: 'isr-no-malloc',
    severity: 'error',
    pattern: String.raw`\b(malloc|calloc|realloc|free|pvPortMalloc|vPortFree)\s*\(`,
    isrOnly: true,
    message: '中断里做了动态内存分配/释放',
    why: '堆操作要拿锁，在中断里可能死锁或破坏堆结构。中断里只能用预分配的静态缓冲。',
  },
  {
    id: 'isr-no-blocking-delay',
    severity: 'error',
    pattern: String.raw`\b(HAL_Delay|vTaskDelay|osDelay|delay_ms|delay_us)\s*\(`,
    isrOnly: true,
    message: '中断里调用了阻塞延时',
    why: '中断里阻塞会把整个系统卡住。需要延时就用定时器或状态机。',
  },
  {
    id: 'isr-use-fromisr',
    severity: 'warn',
    pattern: String.raw`\b(xQueueSend|xQueueReceive|xSemaphoreGive|xSemaphoreTake|xTaskNotify)\s*\(`,
    isrOnly: true,
    message: '中断里用了非 FromISR 版本的 FreeRTOS API',
    why: '中断上下文必须用 ...FromISR 变体并处理 pxHigherPriorityTaskWoken，否则行为未定义。',
  },
  {
    id: 'volatile-shared-flag',
    severity: 'warn',
    pattern: String.raw`^(?!\s*volatile)(static\s+)?(uint8_t|uint16_t|uint32_t|int|bool|_Bool)\s+\w*(flag|Flag|ready|Ready|done|Done)\w*\s*(=|;)`,
    // 两道收敛：只看文件作用域的全局变量，且本文件里得真有中断服务函数。
    // 不收敛的话光新模板就报 175 条，绝大多数是局部变量与厂商代码，没人会看。
    fileScopeOnly: true,
    requiresIsrInFile: true,
    message: '疑似中断与任务共享的全局标志位没加 volatile',
    why: '编译器优化后可能把变量缓存进寄存器，导致任务永远看不到中断里的修改。跨中断共享的变量必须 volatile。本文件含中断服务函数，故重点提示。',
  },
  {
    id: 'critical-section-pair',
    severity: 'warn',
    pattern: String.raw`\b(taskENTER_CRITICAL|__disable_irq|portENTER_CRITICAL)\s*\(`,
    message: '进入了临界区/关中断',
    why: '必须确认所有分支（含提前 return 与异常路径）都成对退出，否则中断永久关闭。本检查只提示位置，需人工核对配对。',
  },
  {
    id: 'estop-software-bypass',
    severity: 'error',
    pattern: String.raw`(estop|e_stop|emergency|急停)`,
    message: '代码中出现急停相关逻辑',
    why: '规则 12.2 要求红色急停按钮为硬件回路。若这里是「软件读急停引脚再决定是否停机」，则急停可被软件旁路 —— 必须由硬件直接切断驱动使能/动力，软件只能做辅助上报。请人工核对接线。',
  },
  {
    id: 'watchdog-feed-in-loop',
    severity: 'info',
    pattern: String.raw`\b(HAL_IWDG_Refresh|IWDG_ReloadCounter|WWDG_Refresh)\s*\(`,
    message: '看门狗喂狗点',
    why: '喂狗应放在能反映系统健康的位置。如果放在一个即使任务卡死也照跑的地方（比如空闲钩子里无条件喂），看门狗就失去意义。',
  },
]

/** 粗略判断一个函数名是否是中断服务函数。 */
function isIsrName(name: string): boolean {
  return /(_IRQHandler|_Handler|_ISR|Callback)$/.test(name)
}

type FunctionSpan = {
  name: string
  startLine: number
  endLine: number
  isIsr: boolean
}

/**
 * 极简的函数体切分：靠大括号配对。
 *
 * **不是完整的 C 解析器**，遇到宏里的不配对大括号会失准 —— 这是启发式检查
 * 可以接受的代价。宁可偶尔漏一处，也不为了精确去引一个 C 语法树依赖。
 */
export function findFunctions(source: string): FunctionSpan[] {
  const lines = source.split(/\r?\n/)
  const out: FunctionSpan[] = []
  // 形如 `void USART1_IRQHandler(void)` 的函数头
  const head = /^[A-Za-z_][\w\s*&:<>,]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*(\{)?\s*$/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s*(if|for|while|switch|return|else|do)\b/.test(line)) continue
    const m = head.exec(line)
    if (!m || !m[1]) continue

    // 找函数体起始的 {
    let depth = 0
    let started = false
    let end = i
    for (let j = i; j < lines.length && j < i + 4000; j++) {
      const l = lines[j] ?? ''
      for (const ch of l) {
        if (ch === '{') {
          depth++
          started = true
        } else if (ch === '}') depth--
      }
      if (started && depth <= 0) {
        end = j
        break
      }
    }
    if (!started) continue
    out.push({ name: m[1], startLine: i + 1, endLine: end + 1, isIsr: isIsrName(m[1]) })
    i = end
  }
  return out
}

/** 一行是否被就地豁免。 */
function isSuppressed(line: string, ruleId: string): boolean {
  const m = /rcs-lint-ignore:\s*([\w-]+)/.exec(line)
  return m?.[1] === ruleId
}

/**
 * 默认排除的厂商与第三方目录。
 *
 * 只查队内代码。把 HAL、CMSIS、标准库、RTOS 内核一起扫进来毫无意义 ——
 * 那些代码不归我们改，报出来只会把真问题淹掉（实测新模板会从 253 条降到个位数量级）。
 */
export const VENDOR_DIRS = [
  'Drivers', 'Middlewares', 'CMSIS', 'FWLIB', 'CORE', 'SYSTEM',
  'uCOS-II', 'ThirdParty_Module', 'OBJ', 'build',
  // MDK 会把 CMSIS 头放进 .cmsis/RTE，实测会漏进来
  '.cmsis', 'RTE', 'DebugConfig', 'Listings',
]

export type EmbeddedLintOptions = {
  rules?: EmbeddedRule[]
  /** 只检查这些目录（相对 root）。省略则查全部非厂商目录。 */
  includeDirs?: string[]
  /** 额外排除的目录名，会与 VENDOR_DIRS 合并。 */
  excludeDirs?: string[]
}

/**
 * 对一个固件工程做嵌入式规范检查。
 *
 * @param root 工程根目录
 */
export function lintEmbedded(root: string, options: EmbeddedLintOptions = {}): CheckResult {
  const rules = options.rules ?? DEFAULT_EMBEDDED_RULES
  const findings: Finding[] = []
  const compiled = rules.map((r) => ({ rule: r, re: new RegExp(r.pattern) }))

  const skipDirs = [...VENDOR_DIRS, ...(options.excludeDirs ?? [])]
  const files = walkFiles(root, {
    extensions: ['.c', '.cpp', '.h', '.hpp'],
    skipDirs,
  }).filter((f) => {
    if (!options.includeDirs?.length) return true
    const rel = relPath(root, f)
    return options.includeDirs.some((d) => rel.startsWith(d))
  })

  let isrCount = 0

  for (const file of files) {
    const text = readText(file)
    if (!text) continue
    const lines = text.split(/\r?\n/)
    const fns = findFunctions(text)
    isrCount += fns.filter((f) => f.isIsr).length

    // 行号 → 所在函数
    const fnAt = (lineNo: number): FunctionSpan | undefined =>
      fns.find((f) => lineNo >= f.startLine && lineNo <= f.endLine)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      // 跳过注释行，避免把说明文字当代码
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue

      for (const { rule, re } of compiled) {
        if (!re.test(line)) continue
        if (isSuppressed(line, rule.id)) continue

        const fn = fnAt(i + 1)
        if (rule.isrOnly && !fn?.isIsr) continue
        if (rule.fileScopeOnly && fn) continue
        if (rule.requiresIsrInFile && !fns.some((x) => x.isIsr)) continue

        findings.push({
          rule: rule.id,
          severity: rule.severity,
          message: fn ? `${rule.message}（函数 ${fn.name}）` : rule.message,
          file: relPath(root, file),
          line: i + 1,
          detail: rule.why,
        })
      }
    }
  }

  const byRule: Record<string, number> = {}
  for (const f of findings) byRule[`rule:${f.rule}`] = (byRule[`rule:${f.rule}`] ?? 0) + 1

  return toResult('lint-embedded', root, findings, {
    files: files.length,
    isrFunctions: isrCount,
    ...byRule,
  })
}
