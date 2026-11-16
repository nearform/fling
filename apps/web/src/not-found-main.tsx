/**
 * The standalone 404 (vite.404.config.ts → dist-404/404.html), served by the sites distribution as
 * /_fling/404.html on any site host. Everything is inlined and nothing in it names an instance: the
 * app origin comes from the `fling-app-origin` meta the deploy fills in (notFoundAppOrigin), and the
 * name and brand from that origin's metadata, fetched cross-origin, best effort. At the root of a
 * site just published, before the edge has it, it holds and reloads instead (lib/arrival.ts).
 */
import type { InstanceMetadata } from '@fling/shared'
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { NotFound } from './components/NotFound'
import { InstanceProvider } from './hooks/instance'
import { shouldHold, waitForArrival } from './lib/arrival'
import {
  applyBrand,
  brandCacheFor,
  fetchInstance,
  notFoundAppOrigin,
  readBrandCache,
} from './lib/instance'
import './not-found.css'

const appOrigin = notFoundAppOrigin(
  document.querySelector('meta[name="fling-app-origin"]')?.getAttribute('content'),
  window.location
)

// In a frame (review mode) home is the site's own, so the frame never leaves the site.
const framed = window.top !== window.self

function Page() {
  const [instance, setInstance] = useState<InstanceMetadata | null>(
    () => readBrandCache()?.metadata ?? null
  )
  // null: still asking; the 404 shows only once the answer is no, so it never flashes first.
  const [arriving, setArriving] = useState<boolean | null>(framed ? false : null)
  useEffect(() => {
    if (framed) return
    let live = true
    shouldHold(appOrigin, window.location).then(async hold => {
      if (!live) return
      setArriving(hold)
      if (!hold) return
      if (await waitForArrival()) window.location.reload()
      else if (live) setArriving(false)
    })
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    fetchInstance(appOrigin)
      .then(metadata => {
        applyBrand(brandCacheFor(metadata), { titlePrefix: 'Not found' })
        setInstance(metadata)
      })
      .catch(() => {})
  }, [])
  return (
    <InstanceProvider value={instance}>
      {arriving === null ? null : framed ? (
        <NotFound homeHref="/" homeLabel="Back to the site's home page" />
      ) : (
        <NotFound homeHref={`${instance?.appOrigin ?? appOrigin}/`} arriving={arriving} />
      )}
    </InstanceProvider>
  )
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>
)
