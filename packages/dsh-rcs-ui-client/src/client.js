import * as React from 'react'
import emblemUrl from '../assets/xmu-rcs-emblem-128.png'
import { installRcsTheme } from './theme.js'

export const inject = ['slots', 'theme']

const organizationUrl = 'https://github.com/XMU-RCS-rc'

const brandCss = [
  '.rcs-team-brand{align-items:center;background:linear-gradient(135deg,var(--dsw-specific-sidebar-nav-item-active-accent),var(--dsw-specific-sidebar-nav-item-hover));border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 1px 2px rgba(17,63,145,.08);box-sizing:border-box;color:var(--dsw-alias-brand-text);display:flex;flex:0 0 40px;gap:10px;height:40px;justify-content:center;min-width:0;padding:0;text-decoration:none;transition:background 120ms ease,border-color 120ms ease,box-shadow 120ms ease;}',
  '.rcs-team-brand[data-wide="true"]{flex:1 1 auto;justify-content:flex-start;padding:0 10px;}',
  '.rcs-team-brand:hover{background:var(--dsw-specific-sidebar-nav-item-active);border-color:var(--dsw-alias-border-l4);box-shadow:0 2px 6px rgba(17,63,145,.14);}',
  '.rcs-team-brand:active{background:var(--dsw-alias-interactive-bg-active);}',
  '.rcs-team-brand:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;}',
  '.rcs-team-brand__mark{align-items:center;background:#fff;border:1px solid rgba(40,100,220,.26);border-radius:50%;box-sizing:border-box;display:inline-flex;flex:0 0 30px;height:30px;justify-content:center;overflow:hidden;padding:1px;width:30px;}',
  '.rcs-team-brand__image{display:block;height:100%;object-fit:contain;width:100%;}',
  '.rcs-team-brand__label{font-size:13px;font-weight:600;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
].join('')

function installStyles(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.rcsTeamBrandStyle = ''
    style.textContent = brandCss
    document.head.append(style)
    return () => style.remove()
  }, 'rcs-ui-client: team brand styles')
}

/** Compact team-brand entry for the additive sidebar footer slot. */
export function RcsTeamBrand({ wide }) {
  return React.createElement(
    'a',
    {
      'aria-label': '在新标签页打开厦门大学机器人队 GitHub 主页',
      className: 'rcs-team-brand',
      'data-rcs-team-brand': true,
      'data-wide': wide,
      href: organizationUrl,
      rel: 'noreferrer noopener',
      target: '_blank',
      title: '厦门大学机器人队 · GitHub',
    },
    React.createElement(
      'span',
      { 'aria-hidden': true, className: 'rcs-team-brand__mark' },
      React.createElement('img', { alt: '', className: 'rcs-team-brand__image', draggable: false, src: emblemUrl }),
    ),
    wide && React.createElement('span', { className: 'rcs-team-brand__label' }, '厦门大学机器人队'),
  )
}

export function apply(ctx) {
  installRcsTheme(ctx)
  installStyles(ctx)
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'rcs-team-brand',
      order: 200,
      label: '厦门大学机器人队',
    },
    RcsTeamBrand,
  ))
}
