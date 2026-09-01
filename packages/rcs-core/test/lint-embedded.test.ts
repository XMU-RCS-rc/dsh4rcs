/**
 * 嵌入式规范检查测试。
 *
 * 分两部分：
 *   - 合成代码：精确验证每条规则的命中与**不命中**（防误报比防漏报更重要，
 *     一个天天误报的检查等于没有）；
 *   - 真实工程：验证收敛效果与已知结论。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lintEmbedded, findFunctions, DEFAULT_EMBEDDED_RULES } from '../src/lint-embedded.ts'

/** 把一段代码写进临时目录再检查。 */
function lintSource(code: string, filename = 'x.c') {
  const dir = mkdtempSync(join(tmpdir(), 'rcs-lint-'))
  writeFileSync(join(dir, filename), code, 'utf8')
  return lintEmbedded(dir)
}

const rulesHit = (code: string): string[] => lintSource(code).findings.map((f) => f.rule)

describe('findFunctions', () => {
  it('识别函数与中断服务函数', () => {
    const fns = findFunctions(`
void USART1_IRQHandler(void)
{
  int a = 1;
}

int normal_fn(int x)
{
  return x;
}
`)
    expect(fns.map((f) => f.name)).toEqual(['USART1_IRQHandler', 'normal_fn'])
    expect(fns[0]?.isIsr).toBe(true)
    expect(fns[1]?.isIsr).toBe(false)
  })

  it('不把 if/for/while 当成函数', () => {
    const fns = findFunctions(`
void f(void)
{
  if (x)
  {
    for (int i = 0; i < 3; i++) { }
  }
}
`)
    expect(fns.map((f) => f.name)).toEqual(['f'])
  })
})

describe('中断内禁忌', () => {
  it('中断里 printf 判 error', () => {
    expect(rulesHit(`
void TIM2_IRQHandler(void)
{
  printf("tick");
}
`)).toContain('isr-no-printf')
  })

  it('普通函数里 printf 不报 —— 只有中断里才是问题', () => {
    expect(rulesHit(`
void normal_task(void)
{
  printf("hello");
}
`)).not.toContain('isr-no-printf')
  })

  it('中断里 malloc / 阻塞延时都判 error', () => {
    const hits = rulesHit(`
void DMA1_Stream0_IRQHandler(void)
{
  void *p = pvPortMalloc(16);
  HAL_Delay(10);
}
`)
    expect(hits).toContain('isr-no-malloc')
    expect(hits).toContain('isr-no-blocking-delay')
  })

  it('中断里用非 FromISR 的 FreeRTOS API 给警告', () => {
    expect(rulesHit(`
void EXTI0_IRQHandler(void)
{
  xQueueSend(q, &v, 0);
}
`)).toContain('isr-use-fromisr')
  })

  it('Callback 结尾的函数也算中断上下文', () => {
    expect(rulesHit(`
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *h)
{
  printf("rx");
}
`)).toContain('isr-no-printf')
  })
})

describe('volatile 共享标志（重点防误报）', () => {
  it('文件含中断 + 全局标志位未加 volatile → 报', () => {
    expect(rulesHit(`
uint8_t rx_flag = 0;

void USART1_IRQHandler(void)
{
  rx_flag = 1;
}
`)).toContain('volatile-shared-flag')
  })

  it('已加 volatile 不报', () => {
    expect(rulesHit(`
volatile uint8_t rx_flag = 0;

void USART1_IRQHandler(void)
{
  rx_flag = 1;
}
`)).not.toContain('volatile-shared-flag')
  })

  it('文件里没有中断服务函数时不报 —— 那就不是跨中断共享', () => {
    expect(rulesHit(`
uint8_t rx_flag = 0;

void plain_fn(void)
{
  rx_flag = 1;
}
`)).not.toContain('volatile-shared-flag')
  })

  it('函数内的局部变量不报 —— 局部变量没有跨上下文问题', () => {
    expect(rulesHit(`
void USART1_IRQHandler(void)
{
  uint8_t done_flag = 0;
  (void)done_flag;
}
`)).not.toContain('volatile-shared-flag')
  })
})

describe('急停检查（对应规则 12.2）', () => {
  it('出现急停相关标识就提示人工核对硬件回路', () => {
    const r = lintSource(`
void check(void)
{
  if (read_estop_pin()) stop_all();
}
`)
    const f = r.findings.find((x) => x.rule === 'estop-software-bypass')
    expect(f).toBeDefined()
    expect(f?.severity).toBe('error')
    expect(f?.detail).toContain('12.2')
    expect(f?.detail).toContain('硬件')
  })
})

describe('豁免与噪声控制', () => {
  it('行内 rcs-lint-ignore 可豁免指定规则', () => {
    expect(rulesHit(`
void TIM2_IRQHandler(void)
{
  printf("tick"); // rcs-lint-ignore: isr-no-printf 仅调试期使用
}
`)).not.toContain('isr-no-printf')
  })

  it('豁免只对指定规则生效，不误伤其它规则', () => {
    const hits = rulesHit(`
void TIM2_IRQHandler(void)
{
  HAL_Delay(1); // rcs-lint-ignore: isr-no-printf
}
`)
    expect(hits).toContain('isr-no-blocking-delay')
  })

  it('注释行里的关键字不算代码', () => {
    expect(rulesHit(`
// printf 在中断里是禁止的
void TIM2_IRQHandler(void)
{
  int a = 0; (void)a;
}
`)).not.toContain('isr-no-printf')
  })
})

describe('规则集完整性', () => {
  it('没有重复的规则 id', () => {
    const ids = DEFAULT_EMBEDDED_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每条规则都写清了「为什么这样写有问题」', () => {
    for (const r of DEFAULT_EMBEDDED_RULES) {
      expect(r.why.length, `${r.id} 的 why 太短`).toBeGreaterThan(20)
    }
  })

  it('所有正则都能编译', () => {
    for (const r of DEFAULT_EMBEDDED_RULES) {
      expect(() => new RegExp(r.pattern), `${r.id} 正则非法`).not.toThrow()
    }
  })
})

const TEMPLATE = 'D:/code/RCS_code/template/RCS_Template_F407'
const hasTemplate = existsSync(TEMPLATE)

describe.skipIf(!hasTemplate)('对真实模板工程', () => {
  it('厂商代码被排除，结果保持在可读规模', () => {
    const r = lintEmbedded(TEMPLATE)
    // 不收敛时会有 250+ 条（含 HAL/CMSIS），那种量级没人会看
    expect(r.stats['total']).toBeLessThan(30)
    expect(r.findings.every((f) => !f.file?.includes('Drivers/'))).toBe(true)
    expect(r.findings.every((f) => !f.file?.includes('.cmsis'))).toBe(true)
  })

  it('查出例程里中断回调中的 printf', () => {
    const r = lintEmbedded(TEMPLATE)
    const f = r.findings.find((x) => x.rule === 'isr-no-printf')
    expect(f?.file).toContain('uart_test')
  })

  it('每条发现都带文件、行号与解释', () => {
    for (const f of lintEmbedded(TEMPLATE).findings) {
      expect(f.file).toBeTruthy()
      expect(f.line).toBeGreaterThan(0)
      expect(f.detail?.length ?? 0).toBeGreaterThan(20)
    }
  })
})
