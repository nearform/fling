/**
 * The site's live room, while a review page is open and the instance has the `live` capability:
 * who else is reviewing, their pointers, and a signal to refetch the comments when someone changes
 * them. It asks the API for a ticket (policy decides who may join) and connects to the URL the API
 * names, so nothing here knows which cloud runs the room. A dropped connection reconnects with
 * backoff and a fresh ticket; it says `hello` on opening (the room answers `welcome`), and a ping
 * keeps idle sockets open through proxies. Your welcome and each newcomer are announced: a toast
 * with their colour, and `announcement` for the page's screen-reader live region.
 */
import { type CommentAnchor, type LiveClientMessage, LiveServerMessageSchema } from '@fling/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../lib/api'
import {
  applyLiveMessage,
  EMPTY_LIVE,
  type LiveState,
  liveAnnouncement,
  liveSocketUrl,
  reconnectDelay,
} from '../lib/live'
import type { FrameLocation } from '../lib/review'
import { showToast } from '../lib/toast'
import { queryKeys } from './queries'

const PING_MS = 25_000

export interface Live extends LiveState {
  connected: boolean
  /** the latest arrival announced, for a screen-reader live region */
  announcement: string
  /** Tell the room where this reviewer's pointer is (null: off the page). */
  sendCursor(at: FrameLocation, anchor: CommentAnchor | null): void
}

export function useLive(name: string, enabled: boolean): Live {
  const queryClient = useQueryClient()
  const [state, setState] = useState<LiveState>(EMPTY_LIVE)
  const [connected, setConnected] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const socket = useRef<WebSocket | null>(null)
  // The room as the socket handler last left it, to tell what a message changed.
  const room = useRef<LiveState>(EMPTY_LIVE)

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let attempt = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let ping: ReturnType<typeof setInterval> | undefined

    const later = () => {
      if (!stopped) retry = setTimeout(connect, reconnectDelay(attempt++))
    }

    async function connect() {
      let ws: WebSocket
      try {
        const ticket = await api.liveTicket(name)
        if (stopped) return
        ws = new WebSocket(liveSocketUrl(ticket, window.location.href))
      } catch (error) {
        // Not allowed in, or no live room here: stop; anything else may pass.
        if (error instanceof ApiError && [403, 404].includes(error.status)) return
        return later()
      }
      socket.current = ws
      ws.onopen = () => {
        attempt = 0
        setConnected(true)
        // The room answers with `welcome`: who this connection is and who else is here.
        send(ws, { type: 'hello' })
        ping = setInterval(() => send(ws, { type: 'ping' }), PING_MS)
      }
      ws.onmessage = e => {
        let data: unknown
        try {
          data = JSON.parse(String(e.data))
        } catch {
          return
        }
        const parsed = LiveServerMessageSchema.safeParse(data)
        if (!parsed.success) return
        if (parsed.data.type === 'comments') {
          queryClient.invalidateQueries({ queryKey: queryKeys.comments(name) })
        }
        const before = room.current
        room.current = applyLiveMessage(before, parsed.data)
        setState(room.current)
        const said = liveAnnouncement(before, parsed.data)
        if (said) {
          showToast(said.text, 'info', 4000, { dot: said.colour })
          setAnnouncement(said.text)
        }
      }
      ws.onclose = () => {
        clearInterval(ping)
        if (socket.current === ws) socket.current = null
        setConnected(false)
        room.current = EMPTY_LIVE
        setState(EMPTY_LIVE)
        later()
      }
    }

    connect()
    return () => {
      stopped = true
      clearTimeout(retry)
      clearInterval(ping)
      socket.current?.close()
      socket.current = null
      setConnected(false)
      room.current = EMPTY_LIVE
      setState(EMPTY_LIVE)
    }
  }, [name, enabled, queryClient])

  const sendCursor = useCallback((at: FrameLocation, anchor: CommentAnchor | null) => {
    const ws = socket.current
    if (ws) send(ws, { type: 'cursor', path: at.path, hash: at.hash, anchor })
  }, [])

  return { ...state, connected, announcement, sendCursor }
}

function send(ws: WebSocket, m: LiveClientMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
}
