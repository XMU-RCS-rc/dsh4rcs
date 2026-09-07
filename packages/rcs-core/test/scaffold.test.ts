/**
 * 基线裁剪测试。
 *
 * 这里的断言密度按**安全模块**的标准来写，理由：
 * 裁剪失败却把文件发出去 = 直接把答案给了学员，而且没人会举报自己拿到答案。
 * 所以"失败时必须失败"这件事，比"成功时结果正确"更要紧。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { trimBaseline, scaffoldBanner } from '../src/scaffold.ts'

const SRC = `
#include "ring_buffer.h"

static bool is_power_of_two(size_t x)
{
    return (x != 0U) && ((x & (x - 1U)) == 0U);
}

rcs_err_t ring_buffer_init(ring_buffer_t *rb, uint8_t *buf, size_t size)
{
    if (rb == NULL) {
        return RCS_ERR_INVALID_PARAM;
    }
    rb->buf = buf;
    return RCS_OK;
}

size_t ring_buffer_count(const ring_buffer_t *rb)
{
    return rb->head - rb->tail;
}

void ring_buffer_reset(ring_buffer_t *rb)
{
    rb->head = 0U;
}
`

describe('trimBaseline —— 正常裁剪', () => {
  it('挖空指定函数，函数体只剩 TODO 与占位返回', () => {
    const r = trimBaseline(SRC, ['ring_buffer_count'])
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.source).toContain('TODO(ring_buffer_count)')
    expect(r.source).toContain('return 0;')
    // 原实现必须消失
    expect(r.source).not.toContain('rb->head - rb->tail')
  })

  it('没被点名的函数原样保留', () => {
    const r = trimBaseline(SRC, ['ring_buffer_count'])
    if (!r.ok) return
    expect(r.source).toContain('RCS_ERR_INVALID_PARAM')
    expect(r.source).toContain('rb->head = 0U;')
  })

  it('一次挖空多个，互不影响', () => {
    const r = trimBaseline(SRC, ['ring_buffer_count', 'ring_buffer_reset', 'ring_buffer_init'])
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.source).toContain('TODO(ring_buffer_count)')
    expect(r.source).toContain('TODO(ring_buffer_reset)')
    expect(r.source).toContain('TODO(ring_buffer_init)')
    expect(r.source).not.toContain('rb->head - rb->tail')
    expect(r.source).not.toContain('RCS_ERR_INVALID_PARAM')
    // 未点名的仍在
    expect(r.source).toContain('(x & (x - 1U))')
  })

  it('strip 为空时原样返回', () => {
    const r = trimBaseline(SRC, [])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).toBe(SRC)
    expect(r.stripped).toEqual([])
  })

  it('提示语会写进 TODO 里', () => {
    const r = trimBaseline(SRC, ['ring_buffer_count'], '想清楚 head/tail 为什么只增不减')
    if (!r.ok) return
    expect(r.source).toContain('只增不减')
  })
})

describe('trimBaseline —— 按返回类型生成占位', () => {
  const cases: [string, string, string][] = [
    ['void f(void)\n{\n    int x = 1;\n}\n', 'f', '{\n    /* TODO(f)'],
    ['bool g(void)\n{\n    return true;\n}\n', 'g', 'return false;'],
    ['rcs_err_t h(void)\n{\n    return RCS_OK;\n}\n', 'h', 'return RCS_FAIL;'],
    ['size_t i(void)\n{\n    return 9;\n}\n', 'i', 'return 0;'],
    ['uint16_t j(void)\n{\n    return 9;\n}\n', 'j', 'return 0;'],
    ['float k(void)\n{\n    return 1.0f;\n}\n', 'k', 'return 0.0f;'],
    ['char *m(void)\n{\n    return NULL;\n}\n', 'm', 'return NULL;'],
    ['static int n(void)\n{\n    return 1;\n}\n', 'n', 'return 0;'],
  ]

  for (const [src, name, expected] of cases) {
    it(`${name} 的占位返回正确`, () => {
      const r = trimBaseline(src, [name])
      expect(r.ok, `${name} 应当裁剪成功`).toBe(true)
      if (!r.ok) return
      expect(r.source).toContain(expected)
    })
  }

  it('void 函数不生成 return 语句', () => {
    const r = trimBaseline('void f(void)\n{\n    int x = 1;\n}\n', ['f'])
    if (!r.ok) return
    expect(r.source).not.toContain('return')
  })
})

describe('trimBaseline —— 失败必须失败（安全性质）', () => {
  it('函数不存在时整体失败，且不返回任何源码', () => {
    const r = trimBaseline(SRC, ['ring_buffer_nonexistent'])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('找不到')
    expect(r.problems.join()).toContain('拒绝交付')
    expect('source' in r).toBe(false)
  })

  it('多个目标里只要有一个找不到，整体失败 —— 不做"尽力而为"', () => {
    const r = trimBaseline(SRC, ['ring_buffer_count', '不存在的函数'])
    expect(r.ok).toBe(false)
  })

  it('存在同名定义（歧义）时失败，不猜哪一个', () => {
    const dup = 'int f(void)\n{\n    return 1;\n}\nint f(void)\n{\n    return 2;\n}\n'
    const r = trimBaseline(dup, ['f'])
    expect(r.ok).toBe(false)
  })

  it('只有声明没有定义时失败', () => {
    const declOnly = 'int f(void);\nint g(void)\n{\n    return f();\n}\n'
    const r = trimBaseline(declOnly, ['f'])
    expect(r.ok).toBe(false)
  })

  it('无法推断返回类型时失败，而不是猜一个编不过的值', () => {
    const weird = 'struct my_weird_t f(void)\n{\n    struct my_weird_t v; return v;\n}\n'
    const r = trimBaseline(weird, ['f'])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.join()).toContain('无法为 f 推断')
  })

  it('空源码失败', () => {
    expect(trimBaseline('', ['f']).ok).toBe(false)
  })
})

describe('trimBaseline —— 不被字符串与注释迷惑', () => {
  it('函数体里出现的花括号字符串不影响配对', () => {
    const src = 'void f(void)\n{\n    printf("}{");\n    int x = 1;\n}\nvoid g(void)\n{\n    int y = 2;\n}\n'
    const r = trimBaseline(src, ['f'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // g 必须完好
    expect(r.source).toContain('int y = 2;')
    expect(r.source).not.toContain('printf("}{")')
  })

  it('注释里的花括号不影响配对', () => {
    const src = 'void f(void)\n{\n    /* } 这里有个假的右括号 */\n    int x = 1;\n}\nvoid g(void)\n{\n    int y = 2;\n}\n'
    const r = trimBaseline(src, ['f'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).toContain('int y = 2;')
  })

  it('函数名出现在注释或调用里，不会被误认为定义', () => {
    const src = '/* 参见 foo() 的说明 */\nvoid bar(void)\n{\n    foo();\n}\nvoid foo(void)\n{\n    int z = 3;\n}\n'
    const r = trimBaseline(src, ['foo'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).not.toContain('int z = 3;')
    // 调用点与注释保持原样
    expect(r.source).toContain('foo();')
    expect(r.source).toContain('参见 foo() 的说明')
  })

  it('嵌套花括号（if/for 块）能正确配对到函数末尾', () => {
    const src = 'void f(void)\n{\n    if (1) {\n        for (;;) {\n            break;\n        }\n    }\n}\nvoid g(void)\n{\n    int y = 2;\n}\n'
    const r = trimBaseline(src, ['f'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).not.toContain('break;')
    expect(r.source).toContain('int y = 2;')
  })
})

describe('scaffoldBanner', () => {
  it('写明这是基线而非完整实现，并列出目标', () => {
    const b = scaffoldBanner('ring-buffer', new Date('2026-10-04T09:00:00Z'), ['补出批量读写'])
    expect(b).toContain('dsh4rcs:training')
    expect(b).toContain('ring-buffer')
    expect(b).toContain('可以跑但功能不全')
    expect(b).toContain('补出批量读写')
    expect(b).toContain('2026-10-04')
  })
})

describe('拿真实的 ring_buffer.c 跑一遍', () => {
  const path = join(
    import.meta.dirname,
    '..', '..', '..', '..',
    'RCS_code', 'template', 'RCS_Template_F103', 'RCS', 'RCS_Support', 'src', 'ring_buffer.c',
  )

  let source = ''
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    // 固件仓库不在本机（CI 上就没有），跳过
  }

  it.skipIf(source === '')('能挖空 curriculum 里点名的那几个函数', () => {
    const strip = [
      'ring_buffer_count',
      'ring_buffer_space',
      'ring_buffer_write',
      'ring_buffer_read',
      'ring_buffer_peek',
    ]
    const r = trimBaseline(source, strip, '让对应的测试变绿')

    if (!r.ok) throw new Error('真实基线裁剪失败：\n' + r.problems.join('\n'))

    for (const n of strip) {
      expect(r.source, `${n} 应当被挖空`).toContain(`TODO(${n})`)
    }
    // 保留下来的基线功能：init / put / get 必须还在
    expect(r.source).toContain('is_power_of_two')
    expect(r.source).toContain('rb->buf[rb->head & rb->mask] = byte;')
  })
})

describe('trimBaseline —— 函数前有文档注释（回归）', () => {
  /*
   * 这是实测撞到的真 bug：signatureStart 撞到 `*​/` 时跳回了注释开头，
   * 把整段文档注释吞进签名，于是推不出返回类型、裁剪整体失败。
   * 五个 F103 例程全都带文档注释，全部发不出去。
   *
   * 它被「裁剪失败就拒绝发放」挡住了，没有静默产出坏文件 ——
   * 但这类形状必须有回归覆盖，因为队内代码规范要求每个函数都写注释。
   */
  const withDoc = `
/**
 *@brief 前一个函数
 */
static void first(void)
{
    int a = 1;
}

/**
 *@brief 目标函数，注释里还有 * 和 / 这类字符
 *@note  甚至有 @brief 这种看起来像类型的东西
 */
static size_t target(const int *p)
{
    return (size_t)*p;
}
`

  it('能正确跳过前置文档注释找到签名', () => {
    const r = trimBaseline(withDoc, ['target'])
    expect(r.ok, r.ok ? '' : r.problems.join('\n')).toBe(true)
    if (!r.ok) return
    expect(r.source).toContain('TODO(target)')
    expect(r.source).toContain('return 0;')
    expect(r.source).not.toContain('return (size_t)*p;')
  })

  it('文档注释本身被保留 —— 学员要靠它知道这个函数该干什么', () => {
    const r = trimBaseline(withDoc, ['target'])
    if (!r.ok) return
    expect(r.source).toContain('目标函数')
    expect(r.source).toContain('@note')
  })

  it('前一个函数不受影响', () => {
    const r = trimBaseline(withDoc, ['target'])
    if (!r.ok) return
    expect(r.source).toContain('int a = 1;')
  })

  it('static 关键字仍被正确识别为签名的一部分', () => {
    const r = trimBaseline(withDoc, ['first'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // first 是 void，函数体应当只剩 TODO 一行，紧跟右花括号（不生成 return）
    expect(r.source).toContain('TODO(first)')
    const body = r.source.slice(r.source.indexOf('TODO(first)'))
    expect(body.slice(0, body.indexOf('}'))).not.toContain('return')
    expect(r.source).not.toContain('int a = 1;')
    // 未点名的 target 完好，它的 return 该留着
    expect(r.source).toContain('return (size_t)*p;')
  })
})
