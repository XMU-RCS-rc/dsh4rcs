import * as React from 'react'
import emblemUrl from '../assets/xmu-rcs-emblem-128.png'

export const inject = ['slots']

const organizationUrl = 'https://github.com/XMU-RCS-rc'

const brandCss = [
  '.rcs-team-brand{align-items:center;background:linear-gradient(135deg,rgba(40,100,220,.14),rgba(255,255,255,.82));border:1px solid rgba(40,100,220,.24);border-radius:10px;box-shadow:0 1px 2px rgba(17,63,145,.08);box-sizing:border-box;color:#174ea6;display:flex;flex:0 0 40px;gap:10px;height:40px;justify-content:center;min-width:0;padding:0;text-decoration:none;transition:background 120ms ease,border-color 120ms ease,box-shadow 120ms ease;}',
  '.rcs-team-brand[data-wide="true"]{flex:1 1 auto;justify-content:flex-start;padding:0 10px;}',
  '.rcs-team-brand:hover{background:linear-gradient(135deg,rgba(40,100,220,.22),rgba(255,255,255,.94));border-color:rgba(40,100,220,.42);box-shadow:0 2px 6px rgba(17,63,145,.14);}',
  '.rcs-team-brand:active{background:linear-gradient(135deg,rgba(40,100,220,.30),rgba(255,255,255,.88));}',
  '.rcs-team-brand:focus-visible{outline:2px solid #2864dc;outline-offset:2px;}',
  'body[data-ds-dark-theme] .rcs-team-brand{background:linear-gradient(135deg,rgba(40,100,220,.30),rgba(12,30,65,.55));border-color:rgba(126,169,255,.34);color:#a9c5ff;}',
  'body[data-ds-dark-theme] .rcs-team-brand:hover{background:linear-gradient(135deg,rgba(40,100,220,.42),rgba(20,45,90,.72));border-color:rgba(144,182,255,.56);}',
  'body[data-ds-dark-theme] .rcs-team-brand:active{background:linear-gradient(135deg,rgba(40,100,220,.50),rgba(20,45,90,.78));}',
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
