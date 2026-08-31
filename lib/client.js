// dsh-tavern settings entry: floating ⚙️ button for /api/tavern/settings
export const inject = ['runtime']

export function apply(ctx) {
  if (document.getElementById('dsh-tavern-settings-btn')) return

  var btn = document.createElement('a')
  btn.id = 'dsh-tavern-settings-btn'
  btn.href = '/api/tavern/settings'
  btn.target = '_blank'
  btn.textContent = '⚙️'
  btn.title = '酒馆设置'
  btn.style.cssText = 'position:fixed;bottom:130px;right:20px;z-index:99999;width:40px;height:40px;border-radius:50%;background:#3b7ff0;color:#fff;display:flex;align-items:center;justify-content:center;text-decoration:none;font-size:18px;box-shadow:0 4px 16px rgba(0,0,0,.35);cursor:pointer'

  var placed = false
  function place() {
    if (placed && document.body.contains(btn)) return
    document.body.appendChild(btn)
    placed = true
  }

  place()
  var obs = new MutationObserver(function () { place() })
  obs.observe(document.body, { childList: true })

  ctx.effect(function () {
    return function () {
      obs.disconnect()
      if (btn.parentNode) btn.parentNode.removeChild(btn)
    }
  }, 'tavern-settings-btn')
}
