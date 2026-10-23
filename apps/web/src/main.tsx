import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// Nearform typefaces, self-hosted: Inter carries all UI; Bitter ships one weight.
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/bitter/latin-700.css'
// The Nearform Labs brand row + app switcher (SideNav); themed by the --labs-* vars in theme.css.
import '@nearform/labs-ui-components/labs-header/styles.css'
import './index.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element not found')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
