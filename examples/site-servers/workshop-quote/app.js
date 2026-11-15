// The page's own script: plain browser code on the same origin as the server, so no CORS.
const hello = document.querySelector('#hello')
const form = document.querySelector('#quote')
const result = document.querySelector('#result')
const request = document.querySelector('#request')

const me = await fetch('/api/me').then(r => r.json())
hello.textContent = me.email
  ? `Signed in as ${me.email}`
  : 'Anyone with the link can price a workshop.'

function quote() {
  const body = Object.fromEntries(new FormData(form))
  return JSON.stringify({ ...body, people: Number(body.people), days: Number(body.days) })
}

async function post(path) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: quote(),
  })
  return { ok: res.ok, data: await res.json() }
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  const { ok, data } = await post('/api/quote')
  result.textContent = ok
    ? `£${data.total.toLocaleString('en-GB')} (${data.breakdown.join(' + ')})`
    : data.error
  request.hidden = !ok || !me.email
})

request.addEventListener('click', async () => {
  const { ok, data } = await post('/api/request')
  result.textContent = ok ? "Sent to the team. They'll be in touch." : data.error
})
