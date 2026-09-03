import * as React from 'react'
import emblemUrl from '../assets/xmu-rcs-emblem-128.png'

export const inject = ['slots']

const repositoryUrl = 'https://github.com/XMU-RCS-rc/dsh4rcs'

const brandCss = [
  '.rcs-team-brand{align-items:center;background:transparent;border-radius:10px;color:inherit;display:flex;flex:0 0 40px;gap:10px;height:40px;justify-content:center;min-width:0;padding:0;text-decoration:none;transition:background-color 120ms ease;}',
  '.rcs-team-brand[data-wide="true"]{flex:1 1 auto;justify-content:flex-start;padding:0 10px;}',
  '.rcs-team-brand:hover{background:rgba(38,96,229,.10);}',
  '.rcs-team-brand:active{background:rgba(38,96,229,.16);}',
  '.rcs-team-brand:focus-visible{outline:2px solid #2660e5;outline-offset:2px;}',
  'body[data-ds-dark-theme] .rcs-team-brand:hover{background:rgba(96,165,250,.14);}',
  'body[data-ds-dark-theme] .rcs-team-brand:active{background:rgba(96,165,250,.22);}',
  '.rcs-team-brand__mark{align-items:center;background:#fff;border-radius:50%;box-sizing:border-box;display:inline-flex;flex:0 0 30px;height:30px;justify-content:center;overflow:hidden;padding:1px;width:30px;}',
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
      'aria-label': '在新标签页打开厦门大学机器人队 dsh4rcs 仓库',
      className: 'rcs-team-brand',
      'data-rcs-team-brand': true,
      'data-wide': wide,
      href: repositoryUrl,
      rel: 'noreferrer noopener',
      target: '_blank',
      title: '厦门大学机器人队 · dsh4rcs',
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
