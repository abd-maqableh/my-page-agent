import { describe, expect, it } from 'vitest'
import { resolveIntent, isOnPath } from '../core/intentRouter'
import { meaningfulWords, normalizeText, looseMatch } from '../core/text'

const pages = {
  Dashboard: {
    path: '/dashboard',
    sections: ['Approval Trends by Entity', 'Monthly Applications Trend', 'حالة طلبات الاستثمار'],
  },
  Applications: { path: '/applications', sections: [] },
  'Government Followup': '/government-followup',
  الطلبات: '/applications',
  'لوحة التحكم': '/dashboard',
}

describe('text helpers', () => {
  it('normalizes Arabic variants and diacritics', () => {
    expect(normalizeText('الطَّلَبات')).toBe('الطلبات')
    expect(normalizeText('أحوال')).toBe('احوال')
  })

  it('extracts meaningful words, dropping fillers and canonicalizing plurals', () => {
    expect(meaningfulWords('show me the Applications page')).toEqual(['application'])
    expect(meaningfulWords('اعرض صفحة الطلبات')).toEqual(['طلبات'])
  })

  it('looseMatch works across Arabic normalization', () => {
    expect(looseMatch('حالة طلبات الاستثمار', 'حاله طلبات الاستثمار')).toBe(true)
  })
})

describe('resolveIntent', () => {
  it('resolves a pure page navigation as complete', () => {
    const routed = resolveIntent('open the applications page', pages)
    expect(routed).toMatchObject({ path: '/applications', complete: true })
    expect(routed?.section).toBeUndefined()
  })

  it('resolves Arabic page labels', () => {
    const routed = resolveIntent('اعرض صفحة الطلبات', pages)
    expect(routed).toMatchObject({ path: '/applications', complete: true })
  })

  it('marks qualifier requests incomplete (navigation prefix only)', () => {
    const routed = resolveIntent('show me sent applications', pages)
    expect(routed).toMatchObject({ path: '/applications', complete: false })
  })

  it('resolves declared sections to their owning page', () => {
    const routed = resolveIntent('take me to approval trends by entity', pages)
    expect(routed).toMatchObject({ path: '/dashboard', section: 'Approval Trends by Entity', complete: true })
  })

  it('resolves shorthand section requests (task words subset of section)', () => {
    const routed = resolveIntent('show approval trends', pages)
    expect(routed).toMatchObject({ path: '/dashboard', section: 'Approval Trends by Entity', complete: true })
  })

  it('resolves Arabic section names', () => {
    const routed = resolveIntent('اعرض حالة طلبات الاستثمار', pages)
    expect(routed).toMatchObject({ path: '/dashboard', section: 'حالة طلبات الاستثمار', complete: true })
  })

  it('returns null for unrelated tasks', () => {
    expect(resolveIntent('fill the contact form with my details', pages)).toBeNull()
    expect(resolveIntent('what is the weather today', pages)).toBeNull()
  })

  it('returns null when no pages are configured', () => {
    expect(resolveIntent('open applications', undefined)).toBeNull()
    expect(resolveIntent('open applications', {})).toBeNull()
  })
})

describe('isOnPath', () => {
  it('matches pathnames ignoring host, query and trailing slash', () => {
    expect(isOnPath('http://localhost:5173/applications?x=1', '/applications')).toBe(true)
    expect(isOnPath('http://localhost:5173/applications/', '/applications')).toBe(true)
    expect(isOnPath('http://localhost:5173/dashboard', '/applications')).toBe(false)
  })
})
