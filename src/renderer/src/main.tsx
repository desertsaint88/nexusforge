import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { BugReportDialog } from './components/BugReportDialog'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Last line of defence: if the app frame itself fails, the error and a report button still show. */}
    <ErrorBoundary area="NexusForge" fallbackExtra={<BugReportDialog />}>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
