/**
 * The standalone 404 (vite.404.config.ts → dist-404/404.html), served by the sites distribution as
 * /_fling/404.html on any site host. Everything is inlined: no fonts are loaded (the brand sheet's
 * stack falls back to the system font), and the only link out is absolute.
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import { NotFound } from './components/NotFound'
import './not-found.css'

const appOrigin = (import.meta.env.VITE_APP_ORIGIN || 'https://fling.labs.nearform.com').replace(
  /\/+$/,
  ''
)

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <NotFound homeHref={`${appOrigin}/`} />
  </React.StrictMode>
)
