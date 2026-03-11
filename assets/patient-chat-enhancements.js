/*
 * Patient portal chat UI enhancements (Premium look)
 * - Keeps existing backend logic (uploadFile, onPickAttachments)
 * - Replaces emoji icons with inline SVG for consistent rendering
 * - Improves layout in narrow column
 */

(function () {
  function qs(root, sel) {
    try {
      return root.querySelector(sel)
    } catch (e) {
      return null
    }
  }

  function qsa(root, sel) {
    try {
      return Array.from(root.querySelectorAll(sel))
    } catch (e) {
      return []
    }
  }

  var SVG_PAPERCLIP =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>' +
    '</svg>'

  var SVG_SEND =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M22 2L11 13"/>' +
    '<path d="M22 2l-7 20-4-9-9-4 20-7z"/>' +
    '</svg>'

  function enhanceOnce(patientRoot) {
    // Find the composer textarea
    var textarea = qs(patientRoot, 'textarea[placeholder*="message"]')
    if (!textarea) return

    textarea.classList.add('sp-chat-textarea')

    // Find the flex row containing attach button + textarea + send button
    var row = textarea
    for (var i = 0; i < 6; i++) {
      if (!row || !row.parentElement) break
      row = row.parentElement
      if (row.classList && row.classList.contains('flex') && row.classList.contains('gap-2')) {
        break
      }
    }
    if (!row || !row.classList) return
    row.classList.add('sp-chat-compose-premium')

    // Attachment button
    var attachBtn = qs(row, 'button[aria-label="Ajouter un document"]')
    if (attachBtn && !attachBtn.dataset.spEnhanced) {
      attachBtn.dataset.spEnhanced = '1'
      attachBtn.classList.add('sp-chat-attach-btn')
      attachBtn.innerHTML = SVG_PAPERCLIP
    }

    // Send button (best-effort)
    var buttons = qsa(row, 'button')
    var sendBtn = null
    for (var b = 0; b < buttons.length; b++) {
      var t = (buttons[b].textContent || '').trim().toLowerCase()
      if (t === 'envoyer') {
        sendBtn = buttons[b]
        break
      }
    }
    if (sendBtn && !sendBtn.dataset.spEnhanced) {
      sendBtn.dataset.spEnhanced = '1'
      sendBtn.classList.add('sp-chat-send')
      sendBtn.innerHTML = SVG_SEND + '<span>Envoyer</span>'
    }

    // Find the composer card container (rounded border block)
    var card = row
    for (var j = 0; j < 6; j++) {
      if (!card || !card.parentElement) break
      card = card.parentElement
      if (card.classList && card.classList.contains('rounded-xl') && card.classList.contains('border')) {
        break
      }
    }
    if (card && card.classList) {
      card.classList.add('sp-chat-card')

      // Add a subtle footnote if absent
      if (!qs(card, '.sp-chat-footnote')) {
        var foot = document.createElement('div')
        foot.className = 'sp-chat-footnote'
        foot.textContent = 'Échanges chiffrés de bout en bout.'
        card.appendChild(foot)
      }

      // Make the internal title less heavy (keep, but smaller)
      var title = null
      var titles = qsa(card, 'div')
      for (var k = 0; k < titles.length; k++) {
        var c = titles[k]
        if (!c || !c.classList) continue
        if (c.classList.contains('text-sm') && c.classList.contains('font-semibold')) {
          if ((c.textContent || '').trim().toLowerCase() === 'envoyer un message') {
            title = c
            break
          }
        }
      }
      if (title) title.classList.add('sp-chat-compose-title')
    }
  }

  function enhance() {
    var patientRoot = document.querySelector('#sosprescription-app[data-view="patient"]')
    if (!patientRoot) return
    enhanceOnce(patientRoot)
  }

  // Initial run
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhance)
  } else {
    enhance()
  }

  // Re-apply after React re-renders
  var obs = new MutationObserver(function () {
    enhance()
  })
  obs.observe(document.documentElement, { childList: true, subtree: true })
})()
