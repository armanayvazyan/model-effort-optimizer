export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'

/** A model tier plus an effort level: what one request is sent with. */
export type Route = { tier: Tier; effort: Effort }

/** The line shown above the prompt after the router changed the route. */
export type Notice = {
  /** Unique per notice, so an old auto-hide timer never clears a newer one. */
  id: number
  route: Route
  /** What the pickers were set to before the router stepped in, where known. */
  previous: string
  /** The classifier's short reason. */
  reason: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-effort-optimizer': {
      notice: Notice | null
      /** The route pinned on main-chat requests, or null when the pickers rule. */
      pinned: Route | null
    }
  }
}
