import React, { useState } from 'react'
import { Dashboard } from './pages/Dashboard'
import { Templates } from './pages/Templates'
import { Settings } from './pages/Settings'

type Page = 'dashboard' | 'templates' | 'settings'

export function App(): JSX.Element {
  const [page, setPage] = useState<Page>('dashboard')

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>ultraswarm</h1>
        <nav>
          <button
            className={page === 'dashboard' ? 'active' : ''}
            onClick={() => setPage('dashboard')}
          >
            Dashboard
          </button>
          <button
            className={page === 'templates' ? 'active' : ''}
            onClick={() => setPage('templates')}
          >
            Templates
          </button>
          <button
            className={page === 'settings' ? 'active' : ''}
            onClick={() => setPage('settings')}
          >
            Settings
          </button>
        </nav>
      </aside>
      <main className="main">
        {page === 'dashboard' && <Dashboard />}
        {page === 'templates' && <Templates />}
        {page === 'settings' && <Settings />}
      </main>
    </div>
  )
}
