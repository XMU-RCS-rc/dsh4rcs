/**
 * 基线裁剪 —— 把完整实现挖空成学员的起步模板。纯字符串处理，不碰文件系统。
 *
 * ## 为什么要动态裁剪
 *
 * 仓库里存的永远是**完整实现**（固件真的要用它），发给学员前才按需挖空。
 * 好处是只有一份真相：改了实现不会忘记同步"教学版"，也不会出现两份代码
 * 悄悄分叉、学员照着过时的模板做的情况。
 *
 * ## 必须守住的安全性质
 *
 * **裁剪失败时绝不能把文件发出去。**
 *
 * 如果因为函数改名、格式变化导致找不到目标函数，而我们"尽力而为"地
 * 发出一份没挖干净的文件，那就是把答案直接给了学员 —— 而且没人会发现，
 * 因为学员不会举报自己拿到了答案。
 *
 * 所以本模块的所有失败都是**显式失败**：返回 ok:false 并列出问题，
 * 由调用方拒绝交付。宁可报错让老队员改配置，也不能静默泄题。
 */

/** 裁剪结果。失败时不返回任何源码 —— 从类型上杜绝"失败了还发出去"。 */
export type TrimResult =
  | { ok: true; source: string; stripped: string[] }
  | { ok: false; problems: string[] }

/** 一个被找到的函数在源码中的位置。 */
type FoundFunction = {
  name: string
  /** 签名起始下标（含返回类型） */
  start: number
  /** 函数体左花括号下标 */
  braceOpen: number
  /** 函数体右花括号下标 */
  braceClose: number
  /** 签名文本，用于推断返回类型 */
  signature: string
}

/**
 * 在 C 源码里找到某个函数的定义。
 *
 * 只认**定义**（签名后面跟 `{`），不认声明（跟 `;`）和调用。
 * 做法是先按名字定位候选，再向前吃掉签名、向后做花括号配对。
 *
 * @returns 找到返回位置；找不到或找到多个返回 undefined（歧义等同失败）
 */
function findFunction(source: string, name: string): FoundFunction | undefined {
  const hits: FoundFunction[] = []

  // 函数名后面允许有空白，然后必须是左圆括号
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'g')
  let m: RegExpExecArray | null

  while ((m = re.exec(source)) !== null) {
    const nameStart = m.index
    const parenOpen = m.index + m[0].length - 1

    const parenClose = matchDelimiter(source, parenOpen, '(', ')')
    if (parenClose === -1) continue

    // 参数表之后，跳过空白，必须是 `{` 才算定义
    let i = parenClose + 1
    while (i < source.length && /\s/.test(source[i]!)) i++
    if (source[i] !== '{') continue

    const braceClose = matchDelimiter(source, i, '{', '}')
    if (braceClose === -1) continue

    // 向前吃掉签名：回退到上一个 `}` / `;` / 行首注释结束之后
    const start = signatureStart(source, nameStart)

    hits.push({
      name,
      start,
      braceOpen: i,
      braceClose,
      signature: source.slice(start, parenClose + 1),
    })
  }

  // 找到多个同名定义属于歧义，不猜
  return hits.length === 1 ? hits[0] : undefined
}

/** 转义正则元字符，防止函数名里的特殊字符破坏匹配。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从 open 处开始做括号配对，返回配对的闭合位置。
 * 会跳过字符串、字符常量与注释里的括号。
 */
function matchDelimiter(source: string, open: number, oc: string, cc: string): number {
  let depth = 0

  for (let i = open; i < source.length; i++) {
    const c = source[i]!
    const next = source[i + 1]

    // 跳过行注释
    if (c === '/' && next === '/') {
      const nl = source.indexOf('\n', i)
      if (nl === -1) return -1
      i = nl
      continue
    }
    // 跳过块注释
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return -1
      i = end + 1
      continue
    }
    // 跳过字符串与字符常量
    if (c === '"' || c === "'") {
      const quote = c
      i++
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === quote) break
        i++
      }
      continue
    }

    if (c === oc) depth++
    else if (c === cc) {
      depth--
      if (depth === 0) return i
    }
  }

  return -1
}

/**
 * 从函数名位置往前找签名的起点。
 *
 * 回退到上一个语句边界（`}`、`;`）或注释块结束之后，再跳过空白。
 * 这样 `static rcs_err_t foo(` 里的 `static rcs_err_t` 会被一起吃进签名。
 */
function signatureStart(source: string, nameStart: number): number {
  let i = nameStart - 1

  while (i >= 0) {
    const c = source[i]!
    if (c === '}' || c === ';') break
    /*
     * 撞到 `*​/`（前一个块注释的结尾）就停在这里。
     *
     * 早先这里错误地用 lastIndexOf('/*') 跳回注释**开头**再 break，
     * 于是整段文档注释被吞进签名，placeholderReturn 拿它去推返回类型必然失败。
     * 表现是「无法为 xxx 推断占位返回值，签名是：** @brief ...」。
     *
     * 正确做法是就地停下：i 指向 `/`，下面 start = i + 1 正好落在注释之后。
     */
    if (c === '/' && source[i - 1] === '*') break
    i--
  }

  let start = i + 1
  while (start < nameStart && /\s/.test(source[start]!)) start++
  return start
}

/**
 * 从签名推断一个合法的占位返回语句。
 *
 * 只处理本工程实际用到的几种返回类型。遇到不认识的类型**返回 undefined**，
 * 由调用方判为失败 —— 猜一个可能编不过的返回值，会让学员一上来就面对
 * 一个跟任务无关的编译错误。
 */
function placeholderReturn(signature: string): string | undefined {
  // 取左圆括号之前的部分，末尾的标识符是函数名，之前是返回类型
  const head = signature.slice(0, signature.indexOf('('))
  const tokens = head.trim().split(/\s+/)
  const nameToken = tokens.pop() ?? ''

  // `char *m(...)` 里星号贴在函数名上，pop 掉之后类型会退化成 `char` ——
  // 那样会给指针函数生成 `return 0;`，编译器直接报错。所以先看名字这一侧。
  if (nameToken.startsWith('*')) return '    return NULL;\n'

  const type = tokens.join(' ').replace(/\bstatic\b|\binline\b/g, '').trim()

  if (type === '' || type === 'void') return ''
  if (type.endsWith('*')) return '    return NULL;\n'
  if (type === 'bool') return '    return false;\n'
  if (type === 'rcs_err_t') return '    return RCS_FAIL;\n'
  if (/^(u?int(8|16|32|64)_t|size_t|int|unsigned|long|short|char)$/.test(type)) {
    return '    return 0;\n'
  }
  if (type === 'float' || type === 'double') return '    return 0.0f;\n'

  return undefined
}

/**
 * 把指定函数的函数体挖空。
 *
 * @param source 完整实现的源码
 * @param names  要挖空的函数名
 * @param hint   写进 TODO 里的提示语，通常是任务的 goals 之一
 * @returns 成功返回挖空后的源码；**任何一个函数处理失败都整体失败**
 */
export function trimBaseline(
  source: string,
  names: readonly string[],
  hint = '实现这个函数，让对应的测试变绿',
): TrimResult {
  if (typeof source !== 'string' || source.length === 0) {
    return { ok: false, problems: ['基线源码为空'] }
  }
  if (names.length === 0) {
    return { ok: true, source, stripped: [] }
  }

  const problems: string[] = []
  const found: FoundFunction[] = []

  for (const n of names) {
    const f = findFunction(source, n)
    if (f === undefined) {
      // 可能是改名了、格式变了、或者有重载/同名定义
      problems.push(
        `在基线里找不到唯一的函数定义：${n}` +
          `（可能是改名、格式变化，或存在同名定义）。` +
          `**已拒绝交付** —— 挖不干净就等于把答案发给学员。`,
      )
      continue
    }
    const ret = placeholderReturn(f.signature)
    if (ret === undefined) {
      problems.push(
        `无法为 ${n} 推断占位返回值，签名是：${f.signature.trim()}。` +
          `请在 scaffold 里改用支持的返回类型，或把该函数移出 strip。`,
      )
      continue
    }
    found.push(f)
  }

  if (problems.length > 0) return { ok: false, problems }

  // 从后往前替换，避免前面的改动影响后面的下标
  found.sort((a, b) => b.braceOpen - a.braceOpen)

  let out = source
  for (const f of found) {
    const ret = placeholderReturn(f.signature) ?? ''
    const body = `{\n    /* TODO(${f.name}): ${hint} */\n${ret}}`
    out = out.slice(0, f.braceOpen) + body + out.slice(f.braceClose + 1)
  }

  return { ok: true, source: out, stripped: [...names] }
}

/**
 * 生成发给学员的文件头横幅。
 *
 * 明确写上"这是基线、不是完整实现"，避免学员以为拿到的是最终版本；
 * 同时记录任务 id 与时间，验收时能对上是哪一次发的。
 */
export function scaffoldBanner(taskId: string, at: Date, goals: readonly string[]): string {
  const lines = [
    '/* ================================================================',
    ` * [dsh4rcs:training] 基线模板  task=${taskId}`,
    ` * 发放时间：${at.toISOString()}`,
    ' *',
    ' * 这是一份**可以跑但功能不全**的基线。你的任务是把它扩展完整：',
    ...goals.map((g) => ` *   - ${g}`),
    ' *',
    ' * 挖空的函数标着 TODO。跑一次测试，红的那几条就是还差的功能。',
    ' * ================================================================ */',
    '',
  ]
  return lines.join('\n')
}

/**
 * 为学员工作目录生成一份 CMakeLists。
 *
 * 学员目录是**扁平**的（.c / .h / 测试都在一层），和固件仓库的分层结构不同，
 * 所以不能直接复制仓库里那份 —— 那份的相对路径在这里全都不成立。
 *
 * 少了这个文件，学员拿到源码却编不起来，而报错会指向一个跟任务无关的方向，
 * 非常劝退。这是"给能跑的基线"这条原则的一部分：**能跑**包括能构建。
 *
 * @param taskId    任务 id，写进工程名便于识别
 * @param gtestDir  gtest 静态库与头文件所在目录（WSL 视角的绝对路径）
 * @param sources   要编译的源文件名（工作目录内的相对名）
 * @param tests     测试文件名
 */
export function workspaceCMake(
  taskId: string,
  gtestDir: string,
  sources: readonly string[],
  tests: readonly string[],
): string {
  return `# ${taskId} 的构建脚本（由 rcs_train_scaffold 自动生成）
#
# 跑法 —— **必须在 WSL 里**，因为 gtest 静态库是 Linux ELF 归档，
# Windows 原生工具链链不了：
#
#     wsl -e bash -lc "cd \$(pwd) && mkdir -p build && cd build && cmake .. && make && ./test"
#
# 第一次跑，测试会红一部分 —— 那就是你要补的功能。
cmake_minimum_required(VERSION 3.10)
project(${taskId}_training C CXX)

# gtest 头文件要求 C++17，写成 14 会在编译期 static_assert 失败
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_FLAGS   "\${CMAKE_C_FLAGS} -Wall -Wextra")
set(CMAKE_CXX_FLAGS "\${CMAKE_CXX_FLAGS} -Wall -Wextra")

set(GTEST_DIR "${gtestDir}")

if(NOT EXISTS "\${GTEST_DIR}/libgtest.a")
    message(FATAL_ERROR
        "找不到 gtest 静态库：\${GTEST_DIR}/libgtest.a\n"
        "它在队内固件仓库的 RCS_Template_F407/RCS/RCS_Support/test/lib/ 下。\n"
        "确认固件仓库在本机，或找老队员要一份。")
endif()

include_directories(\${GTEST_DIR}/headers .)

add_library(my_src STATIC
${sources.map((s) => `    ${s}`).join('\n')}
)

add_executable(test
${tests.map((t) => `    ${t}`).join('\n')}
)

target_link_libraries(test
    my_src
    \${GTEST_DIR}/libgtest.a
    \${GTEST_DIR}/libgtest_main.a
    pthread
)
`
}
