export interface RcsThemeTokenModes {
  readonly light: string
  readonly dark: string
}

export interface RcsThemeContext {
  readonly theme: {
    overrideTokens(source: string, tokens: Readonly<Record<string, RcsThemeTokenModes>>): () => void
  }
  effect(setup: () => () => void, description: string): void
}

export declare const rcsThemeTokens: Readonly<Record<string, RcsThemeTokenModes>>

export declare function installRcsTheme(ctx: RcsThemeContext): void
