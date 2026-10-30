// The builder's Ask tab: a short conversation with the planning assistant.
//
// The server runs the turn and streams it back (src/routes/agent.ts); this file
// sends the ride the builder is holding, shows the progress lines as they arrive,
// and shows any edit as a PROPOSAL: the list of changes with Apply and Discard.
// Nothing touches the ride until Apply, which hands it to TBBuilder.applyAgent()
// as one step on Undo and leaves the save to the builder's own autosave. That gate
// is what keeps text planted in a ride or a place result from reaching a write the
// rider never looked at.
//
// THE TRANSCRIPT LIVES IN THIS TAB AND NOWHERE ELSE. It is never stored, so there
// is nothing to export, purge or leak; a reload starts a fresh conversation, and
// the ride, which is what actually carries the work, is re-read on every turn.
//
// A POST, SO NOT AN EventSource: that API can only GET. The stream is read off a
// fetch body and split into SSE frames by hand, which is a few lines.
(function () {
  "use strict";

  const form = document.getElementById("ask-form");
  if (!form) return;
  const input = document.getElementById("ask-input");
  const send = document.getElementById("ask-send");
  const log = document.getElementById("ask-log");
  const status = document.getElementById("ask-status");
  const history = [];
  let busy = false;
  // The proposal still waiting for an answer, if any. A new message supersedes it:
  // the next turn is sent the ride as it stands, without it.
  let pending = null;

  async function refreshStatus() {
    try {
      const res = await fetch("/api/agent/status", { credentials: "same-origin" });
      if (!res.ok) return;
      const s = await res.json();
      status.textContent = s.line || "";
      input.disabled = !s.available;
      send.disabled = !s.available || busy;
    } catch {
      /* The tab still works; the line is a courtesy. */
    }
  }

  function line(role, text) {
    const li = document.createElement("li");
    li.className = "ask-line ask-" + role;
    const body = document.createElement("p");
    body.className = "ask-text";
    body.textContent = text;
    li.appendChild(body);
    log.appendChild(li);
    li.scrollIntoView({ block: "end" });
    return li;
  }

  function setBusy(on) {
    busy = on;
    send.disabled = on;
    input.disabled = on;
    // Map and list edits are held while a turn runs: the copy the assistant is
    // editing was taken when it started, so an edit made now would be lost.
    document.documentElement.classList.toggle("ask-busy", on);
  }

  // Yields [event, data] pairs from a text/event-stream body.
  async function* frames(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let event = "message";
        let data = "";
        for (const l of raw.split("\n")) {
          if (l.startsWith("event:")) event = l.slice(6).trim();
          else if (l.startsWith("data:")) data += l.slice(5).trim();
        }
        try {
          yield [event, data ? JSON.parse(data) : null];
        } catch {
          /* A frame that is not JSON is a keep-alive. */
        }
      }
    }
  }

  function settle(card, note) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const p = card.querySelector(".ask-proposal-note");
    if (p) p.textContent = note;
    card.classList.add("is-settled");
    if (pending && pending.card === card) pending = null;
  }

  function propose(li, proposal, snap) {
    const card = document.createElement("div");
    card.className = "ask-proposal";
    const head = document.createElement("p");
    head.className = "ask-proposal-head";
    head.textContent = "Proposed changes";
    const list = document.createElement("ul");
    for (const c of proposal.changes || []) {
      const item = document.createElement("li");
      item.textContent = c;
      list.appendChild(item);
    }
    const row = document.createElement("p");
    row.className = "ask-proposal-acts";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "btn";
    apply.textContent = "Apply";
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "btn-quiet";
    discard.textContent = "Discard";
    row.append(apply, " ", discard);
    const note = document.createElement("p");
    note.className = "ask-proposal-note";
    note.setAttribute("aria-live", "polite");
    card.append(head, list, row, note);
    li.appendChild(card);
    li.scrollIntoView({ block: "end" });
    pending = { card };

    apply.addEventListener("click", () => {
      const B = window.TBBuilder;
      if (B && B.applyAgent(proposal.payload, snap)) settle(card, "Applied. Undo takes it back.");
      else settle(card, "The ride changed since I made this, so it can’t be applied. Ask again.");
    });
    discard.addEventListener("click", () => settle(card, "Discarded."));
  }

  async function ask(message) {
    const B = window.TBBuilder;
    if (!B || !B.agentSnapshot) return;
    if (pending) settle(pending.card, "Left out: you asked something else.");
    line("rider", message);
    const reply = line("assistant", "Thinking…");
    reply.classList.add("is-working");
    const text = reply.querySelector(".ask-text");
    setBusy(true);
    let answer = "";
    try {
      const rideId = await B.agentEnsureSaved();
      if (!rideId) {
        text.textContent = "Add a starting point first, then ask.";
        return;
      }
      const snap = B.agentSnapshot();
      const res = await fetch("/api/rides/" + rideId + "/agent", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history: history.slice(-12), payload: snap.ride }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        text.textContent = err.error || "The assistant could not answer just now.";
        return;
      }
      for await (const [event, data] of frames(res)) {
        if (event === "progress" && data) text.textContent = data.text + "…";
        else if (event === "text" && data) text.textContent = answer = data.text;
        else if (event === "error" && data) text.textContent = answer = data.text;
        else if (event === "done" && data) {
          answer = data.reply;
          text.textContent = answer;
          if (data.proposal) {
            if (B.agentStillCurrent && !B.agentStillCurrent(snap)) {
              text.textContent = answer +=
                " (The ride changed while I was working, so I left my changes out. Ask again.)";
            } else {
              propose(reply, data.proposal, snap);
            }
          }
        }
      }
    } catch {
      text.textContent = answer || "The connection dropped before the assistant finished.";
    } finally {
      reply.classList.remove("is-working");
      history.push({ role: "rider", text: message });
      if (answer) history.push({ role: "assistant", text: answer });
      setBusy(false);
      refreshStatus();
      input.focus();
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message || busy) return;
    input.value = "";
    ask(message);
  });

  // Enter sends, Shift+Enter is a new line: the chat convention, and the box is
  // small enough that a rider rarely wants a second line at all.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Status on the first look at the tab, not on page load: a rider who never
  // opens it costs the server nothing.
  const tab = document.getElementById("tab-ask");
  let looked = false;
  if (tab) {
    tab.addEventListener("click", () => {
      if (looked) return;
      looked = true;
      refreshStatus();
    });
  }
})();
