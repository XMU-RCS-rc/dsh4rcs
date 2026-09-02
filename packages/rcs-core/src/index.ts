/**
 * @rcs/core —— RCS 工程检查的纯逻辑核心。
 *
 * 这个包**不依赖 dsh**，可以单独用 vitest 测、用 node 直接跑。
 * dsh 适配层（packages/dsh-rcs-control）只负责把这些函数包成 Tool。
 * 这样 dsh 处于 preview 期的 API 变动只会影响薄薄的适配层。
 */
import { readFileSync } from 'node:fs'

export type { Severity, Finding, CheckResult } from './types.ts'
export { toResult } from './types.ts'

export {
  walkFiles, readText, relPath, fileExists, parseIncludes, isCppFile, fileName,
} from './fsutil.ts'
export type { IncludeRef, WalkOptions } from './fsutil.ts'

export { lintLayers } from './layer-lint.ts'
export type { LayerRulesConfig, PurityRule, ActorRule, ThemeRule } from './layer-lint.ts'

export { checkTemplateGap, checkSupportPairing, analyzeTemplateGap } from './template-gap.ts'
export type { TemplateManifest, TemplateExample, TemplateGapReport, ExampleStatus } from './template-gap.ts'

export { checkRepoHygiene, DEFAULT_HYGIENE } from './repo-hygiene.ts'
export type { HygieneConfig, JunkPattern } from './repo-hygiene.ts'

export { diffRuleDocuments, diffRuleVersions, UnimplementedRuleSource } from './rule-diff.ts'
export { JsonRuleSource, compareVersions, searchClauses } from './rule-source.ts'
export type { ClauseHit } from './rule-source.ts'
export { loadConstraints, checkDesign, extractQuantities } from './rule-check.ts'
export {
  TeamContext, loadTeamConfig, layerOfPath, daysUntil, nextMilestone,
} from './team-context.ts'

export {
  HttpFeishuClient, FeishuPermissionError, FeishuApiError, extractLegacyText,
  recommendScope, describeScopes,
} from './feishu.ts'
export type {
  FeishuClient, FeishuCredentials, DriveNode, FolderPage, HttpClientOptions,
} from './feishu.ts'
export {
  AllowlistGuard, walkAllowlist, syncKnowledgeBase, loadManifest,
  manifestPath, docPath, DEFAULT_SYNC_POLICY,
} from './kb-sync.ts'
export type {
  KbSource, SyncPolicy, KbDoc, KbManifest, SyncStats, SyncResult, SyncOptions,
  WalkedNode, WalkResult,
} from './kb-sync.ts'
export { searchKb, kbStatus, readDocText, snippetsAround } from './kb-index.ts'
export type { KbHit, KbStatus } from './kb-index.ts'

export {
  crc16Modbus, decodeRdlcStream, decodeRdlcPayload, decodeRdlc, parseHexBytes, toHex,
  RDLC_HEAD, RDLC_TAIL, RDLC_ESCAPE, RDLC_MAX_PAYLOAD,
  UPPER_ADDRESS, LOWER_ADDRESS, MSG_COMMAND, MSG_FEEDBACK, MODULE_NAMES, STATUS_NAMES,
} from './rdlc.ts'
export type {
  RdlcFrame, RdlcParseError, RdlcStreamResult, RdlcCommand, RdlcFeedback,
  RdlcPayload, DecodedFrame,
} from './rdlc.ts'

export {
  regularFromInfTo0, regularFromInfTo180, normalizeFrom0ToInf,
  shortestAngleDeg, shortestAngleRad, angleLoopSelfCheck, stripComments,
  checkAngleLoop, checkKinematics, guessSupportRoot,
} from './kin-check.ts'

export {
  probeToolchain, probeWslToolchain, parseKeilLog, buildFirmware, runSupportTests, flashFirmware,
  archiveObjectFormat, parseGtestOutput, UV4_EXIT, KEIL_CANDIDATES, classifyBuildFailure, classifyTestFailure, toWslPath, projectCompilerVersion, keilBundledCompilers,
} from './toolchain.ts'
export type {
  CommandResult, CommandRunner, ProbeDeps, ToolStatus, BuildDiagnostic,
  BuildResult, BuildOptions, TestOutcome, SupportTestOptions, FlashResult, FlashOptions,
} from './toolchain.ts'

export { nodeRunner, nodeDeps, whichSync } from './runner.ts'

export {
  REPO_ROOT, repoRootFrom, repoPaths, looksLikeRcsRepo, resolveRepoRoot,
  repoRootNotFoundMessage, looksLikeFirmwareRepo, resolveFirmwareRoot, firmwareNotFoundMessage,
} from './paths.ts'
export type { RepoResolution, FirmwareResolution } from './paths.ts'

export {
  loadBusMap, scaffoldBusMap, parseRobotLog, advisePid, PENDING_VEHICLE_CAPABILITIES,
} from './vehicle-contract.ts'
export type {
  ActuatorKind, BusEntry, BusMap, BusMapLoad, LogRecord, LogParseResult, PidSample,
} from './vehicle-contract.ts'
export { decide, fieldGuard, levelOf, DEFAULT_DANGER_RULES } from './danger.ts'
export { lintEmbedded, findFunctions, DEFAULT_EMBEDDED_RULES } from './lint-embedded.ts'
export {
  importRulebook, scaffoldConstraints, paragraphs, toClauses,
  splitInlineClauses, readZipEntry,
} from './rule-import.ts'
export type { ImportResult, ImportedClause } from './rule-import.ts'
export type { EmbeddedRule, EmbeddedLintOptions } from './lint-embedded.ts'
export type { DangerLevel, GuardMode, DangerRule, Decision, GuardConfig } from './danger.ts'
export type {
  TeamConfig, RobotSpec, RobotId, Milestone, FirmwareInfo, FeishuConfig,
} from './team-context.ts'
export type { RuleConstraints, Quantity } from './rule-check.ts'
export type {
  RuleClause, RuleDocument, RuleChange, RuleChangeKind, RuleDiffResult, RuleSource,
} from './rule-diff.ts'

/** 读取 JSON 配置。配置文件里允许 `$` 开头的注释键，运行时忽略。 */
export function loadJsonConfig<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
