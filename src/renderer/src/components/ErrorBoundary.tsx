import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Bug, RotateCw } from 'lucide-react'
import { invoke } from '../lib/api'
import { reportBug } from '../store/bugreport'
import { Button } from './ui'

/**
 * A page that throws while drawing shows this instead of a blank window: what broke, a way back, and a report
 * prefilled with the error. The error is also recorded for bug reports and written to the log.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; area: string; resetKey?: string; fallbackExtra?: ReactNode }, { error?: Error; stack?: string }> {
  state: { error?: Error; stack?: string } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const stack = `${error.stack ?? ''}\n\nComponent stack:${info.componentStack ?? ''}`.slice(0, 6000)
    this.setState({ stack })
    void invoke('bugreport:rendererError', { message: `${this.props.area} crashed: ${error.message}`, detail: stack, page: this.props.area }).catch(() => {})
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    // Navigating elsewhere gives the page another try.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: undefined, stack: undefined })
  }

  render() {
    const { error, stack } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="glass max-w-lg rounded-3xl p-7 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-rose-500/15 text-rose-300">
            <Bug className="size-6" />
          </div>
          <h2 className="text-lg font-semibold text-ink-100">This page ran into a problem</h2>
          <p className="selectable mt-2 text-[13px] leading-relaxed break-words text-ink-300">{error.message}</p>
          <p className="mt-2 text-[12.5px] text-ink-400">Your library and mods are not affected. Try again, or report it so it gets fixed.</p>
          <div className="mt-5 flex justify-center gap-2">
            <Button size="sm" icon={<RotateCw className="size-3.5" />} onClick={() => this.setState({ error: undefined, stack: undefined })}>
              Try again
            </Button>
            <Button variant="primary" size="sm" icon={<Bug className="size-3.5" />} onClick={() => reportBug({ title: `${this.props.area}: ${error.message}`.slice(0, 140), error: { message: error.message, detail: stack }, origin: 'error-screen' })}>
              Report this
            </Button>
          </div>
        </div>
        {this.props.fallbackExtra}
      </div>
    )
  }
}
