/**
 * 构建全部 dsh 插件产物 —— 验证阶梯 L3/L4 的前置。
 *
 * 为什么必须构建，不能让 dsh 直接加载 .ts：
 *   1. 适配层用**相对路径** import `@rcs/core` 与 `@rcs/ui`。
 *      装到别人的 profile 里那些路径不存在，必须把核心逻辑打进产物。
 *   2. dsh 没有 TypeScript 源码加载器（`dsh-typert-loader` 是别的东西，
 *      负责类型化工具注册，不编译 .ts）。
 *
 * 关键：`@deepseek-ai/*` 一律 external。
 *   这几个包必须由 dsh 运行时提供，**绝不能打进产物** —— 否则插件会拿到
 *   与宿主不同的 cordis/dsh-tools 实例，服务标识与 instanceof 都会错乱。
 *   下面会显式检查，混进去就直接报错退出。
 */
import { build } from 'esbuild'
import { rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 所有 dsh 插件包（目录名即包名）。新增插件时加一行即可。 */
const PLUGINS = [
  'dsh-rcs-core',
  'dsh-rcs-guard',
  'dsh-rcs-control',
  'dsh-rcs-rules',
  'dsh-rcs-kb',
  'dsh-rcs-ui-client',
]

if (process.argv.includes('--install-stage')) {
  console.error(`[dsh:install 1/2] 构建 ${PLUGINS.length} 个插件`)
}

let failed = false

for (const name of PLUGINS) {
  const pkgDir = join('packages', name)
  const entry = join(pkgDir, 'src', 'index.ts')
  if (!existsSync(entry)) {
    console.error(`\n跳过 ${name}：入口不存在 ${entry}`)
    continue
  }

  const out = join(pkgDir, 'lib')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  const result = await build({
    entryPoints: [entry],
    outfile: join(out, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    external: ['@deepseek-ai/*', 'node:*'],
    logLevel: 'warning',
    metafile: true,
  })

  const outKey = join(out, 'index.js').split('\\').join('/')
  const inputs = Object.keys(result.metafile.outputs[outKey]?.inputs ?? {})
  const bundled = inputs.filter((p) => p.includes('rcs-core') || p.includes('rcs-ui'))
  const leaked = inputs.filter((p) => p.includes('@deepseek-ai'))

  console.log(`\n${name}  —  打入核心模块 ${bundled.length} 个`)
  for (const p of bundled) console.log(`   ${p}`)

  if (leaked.length > 0) {
    console.error(`   错误：宿主包被打进产物，会造成双实例：`)
    for (const p of leaked) console.error(`     ${p}`)
    failed = true
  }

  const clientEntry = join(pkgDir, 'src', 'client.js')
  if (existsSync(clientEntry)) {
    const clientResult = await build({
      entryPoints: [clientEntry],
      bundle: true,
      platform: 'browser',
      target: 'es2022',
      format: 'cjs',
      write: false,
      metafile: true,
      external: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/client',
        '@deepseek-ai/*',
      ],
      loader: { '.png': 'dataurl' },
      logLevel: 'warning',
    })
    const body = clientResult.outputFiles[0]?.text
    if (!body) {
      console.error('   错误：' + name + ' 客户端构建没有产出')
      failed = true
      continue
    }
    const clientLeaks = Object.keys(clientResult.metafile.inputs)
      .filter((p) => p.includes('node_modules'))
    if (clientLeaks.length > 0) {
      console.error('   错误：客户端宿主包被打进产物，会造成双实例：')
      for (const p of clientLeaks) console.error('     ' + p)
      failed = true
      continue
    }
    const maxClientBytes = 60_000
    const clientBytes = Buffer.byteLength(body)
    if (clientBytes > maxClientBytes) {
      console.error('   错误：客户端 bundle 过大（' + clientBytes
        + ' B > ' + maxClientBytes + ' B），请缩小内嵌资源')
      failed = true
      continue
    }
    const wrapped = 'window.__ModuleLoader__.load({\n  id: ' + JSON.stringify(name)
      + ',\n  factory: (require) => {\n    var module = { exports: {} };\n'
      + '    var exports = module.exports;\n' + body
      + '\n    return module.exports;\n  }\n});\n'
    writeFileSync(join(out, 'client.js'), wrapped)
    console.log('   客户端资源  ' + name + '/lib/client.js（'
      + clientBytes + ' B，队徽已内嵌）')
  }
}

if (failed) {
  console.error('\n构建失败：存在宿主包泄漏。')
  process.exit(1)
}
console.log('\n全部插件构建完成，宿主包已外置，无双实例风险。')
