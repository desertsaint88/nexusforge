/// <reference types="vite/client" />
import type { NexusApi } from '@shared/ipc'

declare global {
  interface Window {
    nexus: NexusApi
  }
}

export {}
