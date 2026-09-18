import { describe, expect, test } from 'claude-code/testing'

describe('register', () => {
  test('a session starts as it would without crosstalk', async ($, on) => {
    on('session.start', ($, e) => ({ cwd: e.cwd }))

    expect(await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })).toEqual({
      cwd: '/work',
    })
  })
})
