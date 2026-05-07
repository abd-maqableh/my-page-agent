import './style.css'
import { mountAgentPanel } from './index'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('App root not found')
}

app.innerHTML = `
  <main class="demo-container">
    <h1>My Page Agent MVP Demo</h1>
    <p class="subtitle">This page includes interactive controls for the in-page agent to observe and operate.</p>

    <form class="card" id="demo-form">
      <h2>Demo Form</h2>
      <label>
        Name
        <input name="name" placeholder="Enter your name" />
      </label>
      <label>
        Email
        <input name="email" type="email" placeholder="name@example.com" />
      </label>
      <label>
        Role
        <select name="role">
          <option value="">Pick one</option>
          <option value="developer">Developer</option>
          <option value="designer">Designer</option>
          <option value="manager">Manager</option>
        </select>
      </label>
      <button type="submit">Submit Form</button>
    </form>

    <div class="card actions">
      <h2>Extra Controls</h2>
      <button type="button" id="notify-btn">Show Notification</button>
      <a href="#" id="fake-link">Focusable Link</a>
      <textarea placeholder="Additional notes"></textarea>
      <p id="output"></p>
    </div>
  </main>
`

const output = document.querySelector<HTMLParagraphElement>('#output')
const form = document.querySelector<HTMLFormElement>('#demo-form')
const notifyBtn = document.querySelector<HTMLButtonElement>('#notify-btn')
const fakeLink = document.querySelector<HTMLAnchorElement>('#fake-link')

form?.addEventListener('submit', (event) => {
  event.preventDefault()
  output!.textContent = 'Form submitted (demo only).'
})

notifyBtn?.addEventListener('click', () => {
  output!.textContent = 'Notification button clicked.'
})

fakeLink?.addEventListener('click', (event) => {
  event.preventDefault()
  output!.textContent = 'Link clicked.'
})

mountAgentPanel({
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'REPLACE_WITH_YOUR_KEY',
  model: 'gpt-4.1-mini',
  temperature: 0,
  maxSteps: 8,
})
