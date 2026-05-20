import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from '../App'

describe('<App />', () => {
  it('renders the tagline heading and the DuetMind wordmark', () => {
    render(<App />)
    expect(
      screen.getByRole('heading', { name: /two brains/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /duetmind home/i }),
    ).toBeInTheDocument()
  })
})
