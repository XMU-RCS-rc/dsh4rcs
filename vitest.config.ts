import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // 测试直接读真实工程（D:\code\RCS_code、D:\code\R2），不做 mock。
    // 若这两个目录不存在，相关用例会自动 skip 而不是失败。
    testTimeout: 20_000,
  },
})
