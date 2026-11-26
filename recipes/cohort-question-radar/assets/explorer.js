/* Cohort question radar explorer. Plain browser JavaScript: no libraries, no network calls.
   Reads the embedded data block and builds every element with createElement and textContent. */
(function () {
  "use strict";
  var dataEl = document.getElementById("radar-data");
  var root = document.getElementById("radar-explorer");
  if (!dataEl || !root) return;
  var data = JSON.parse(dataEl.textContent);
  var fallback = document.getElementById("rx-fallback");
  if (fallback) fallback.parentNode.removeChild(fallback);

  var TONE = { yes: "info", no: "neutral", unknown: "unknown", error: "error", not_found: "review", not_asked: "unknown" };
  var state = { question: "", answer: "", group: "", company: "" };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function words(v) { return String(v).replace(/_/g, " "); }
  function badge(value) {
    return el("span", "badge t-" + (TONE[value] || "neutral"), words(value));
  }
  function safeLink(url, text) {
    if (typeof url === "string" && (url.indexOf("https://") === 0 || url.indexOf("http://") === 0)) {
      var a = el("a", null, text);
      a.href = url;
      a.rel = "noopener noreferrer nofollow";
      return a;
    }
    return el("span", null, text);
  }
  function select(labelText, options, key) {
    var label = el("label", null, labelText);
    var s = el("select");
    options.forEach(function (o) {
      var opt = el("option", null, o[1]);
      opt.value = o[0];
      s.appendChild(opt);
    });
    s.value = state[key];
    s.addEventListener("change", function () { state[key] = s.value; draw(); });
    label.appendChild(s);
    return label;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function measureFor(qid) {
    var m = null;
    data.measures.forEach(function (q) {
      if (q.id !== qid) return;
      m = q.measure;
      if (state.group) {
        (q.groups || []).forEach(function (g) { if (g.group === state.group) m = g.measure; });
      }
    });
    return m;
  }

  function visibleQuestions() {
    return data.questions.filter(function (q) { return !state.question || q.id === state.question; });
  }

  function companyVisible(c) {
    if (state.group && c.groups.indexOf(state.group) < 0) return false;
    if (!state.answer) return true;
    return visibleQuestions().some(function (q) {
      var a = c.answers[q.id];
      return a && a.answer === state.answer;
    });
  }

  var filters = el("div", "rx-filters");
  var bars = el("div");
  var countLine = el("p", "muted");
  var matrix = el("div", "scroll");
  var drill = el("div", "card");
  drill.id = "rx-drill";
  root.appendChild(filters);
  root.appendChild(bars);
  root.appendChild(countLine);
  root.appendChild(matrix);
  root.appendChild(drill);

  function drawFilters() {
    clear(filters);
    var qOpts = [["", "All questions"]].concat(data.questions.map(function (q) { return [q.id, q.label]; }));
    filters.appendChild(select("Question", qOpts, "question"));
    var aOpts = [["", "Any answer"]].concat(data.answer_values.map(function (a) { return [a, words(a)]; }));
    filters.appendChild(select("Answer", aOpts, "answer"));
    if (data.group_by) {
      var groups = [];
      data.companies.forEach(function (c) {
        c.groups.forEach(function (g) { if (groups.indexOf(g) < 0) groups.push(g); });
      });
      var gOpts = [["", "All groups"]].concat(groups.map(function (g) { return [g, g]; }));
      filters.appendChild(select("Group (" + data.group_by + ")", gOpts, "group"));
    }
  }

  function drawBars() {
    clear(bars);
    visibleQuestions().forEach(function (q) {
      var m = measureFor(q.id);
      if (!m) return;
      var box = el("div", "rx-q");
      box.appendChild(el("h3", null, q.label));
      var bar = el("div", "rx-bar");
      bar.setAttribute("role", "img");
      var parts = [];
      data.answer_values.forEach(function (a) {
        var n = m[a] || 0;
        parts.push(words(a) + " " + n);
        if (!n || !m.companies_in_cohort) return;
        var seg = el("span", "rx-" + a);
        seg.style.width = (100 * n / m.companies_in_cohort) + "%";
        seg.title = words(a) + ": " + n + " of " + m.companies_in_cohort;
        bar.appendChild(seg);
      });
      bar.setAttribute("aria-label", parts.join(", "));
      box.appendChild(bar);
      box.appendChild(el("p", "muted", parts.join(", ") + ", of " + m.companies_in_cohort + " companies in this cohort" +
        (state.group ? " and group" : "") + "."));
      box.appendChild(el("p", null, "Yes share: " + m.yes_share + ". Unknown share: " + m.unknown_share + "."));
      bars.appendChild(box);
    });
  }

  function drawMatrix() {
    clear(matrix);
    var qs = visibleQuestions();
    var shown = data.companies.filter(companyVisible);
    countLine.textContent = "Showing " + shown.length + " of " + data.companies.length + " companies.";
    var t = el("table");
    var head = el("tr");
    head.appendChild(el("th", null, "Company"));
    if (data.group_by) head.appendChild(el("th", null, "Group"));
    qs.forEach(function (q) { head.appendChild(el("th", null, q.label)); });
    var thead = el("thead");
    thead.appendChild(head);
    t.appendChild(thead);
    var body = el("tbody");
    shown.forEach(function (c) {
      var tr = el("tr");
      var td = el("td");
      var b = el("button", "rx-company", c.label);
      b.type = "button";
      b.addEventListener("click", function () { state.company = c.key; drawDrill(); drill.scrollIntoView({ block: "nearest" }); });
      td.appendChild(b);
      td.appendChild(el("div", "muted", c.identifier));
      tr.appendChild(td);
      if (data.group_by) tr.appendChild(el("td", null, c.groups.join(", ")));
      qs.forEach(function (q) {
        var cell = el("td");
        var a = c.answers[q.id];
        cell.appendChild(a ? badge(a.answer) : el("span", "muted", "none"));
        tr.appendChild(cell);
      });
      body.appendChild(tr);
    });
    t.appendChild(body);
    matrix.appendChild(t);
  }

  function line(parent, label, value) {
    if (value === null || value === undefined || value === "") return;
    var p = el("p");
    p.appendChild(el("strong", null, label + ": "));
    p.appendChild(document.createTextNode(String(value)));
    parent.appendChild(p);
  }

  function drawDrill() {
    clear(drill);
    var c = null;
    data.companies.forEach(function (x) { if (x.key === state.company) c = x; });
    if (!c) {
      drill.appendChild(el("p", "muted", "Select a company in the table to see its answers with the reasons and sources as returned."));
      return;
    }
    drill.appendChild(el("h3", null, c.label));
    drill.appendChild(el("p", "muted", "Identifier sent: " + c.identifier + ". Rows: " + c.row_ids.join(", ") + "."));
    var fid = el("p");
    fid.appendChild(document.createTextNode("Firmable ID: "));
    if (c.firmable_id) fid.appendChild(safeLink(c.profile_url, c.firmable_id));
    else fid.appendChild(el("span", "muted", "not returned"));
    drill.appendChild(fid);
    line(drill, "Status", words(c.status) + ". " + (c.status_reason || ""));
    data.questions.forEach(function (q) {
      var a = c.answers[q.id];
      if (!a) return;
      var box = el("div", "card");
      var h = el("div", "card-head");
      h.appendChild(el("strong", null, q.label + " (" + q.tool + ")"));
      h.appendChild(badge(a.answer));
      box.appendChild(h);
      line(box, "Confidence", a.confidence);
      line(box, "Reason", a.reason);
      line(box, "Source", a.source);
      line(box, "Fact date", a.fact_date);
      line(box, "Last refreshed", a.last_refreshed);
      line(box, "Would change if", a.would_change_if);
      line(box, "Error", a.error);
      if (a.details && typeof a.details === "object") {
        var keys = Object.keys(a.details);
        if (keys.length) {
          var ul = el("ul");
          keys.forEach(function (k) {
            var v = a.details[k];
            ul.appendChild(el("li", null, k + ": " + (v === null ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v))));
          });
          box.appendChild(el("p", "muted", "Details as returned:"));
          box.appendChild(ul);
        }
      }
      if (a.answer === "yes" || a.answer === "no" || a.answer === "unknown") {
        if (!a.reason) box.appendChild(el("p", "muted", "No reason returned. Ask with with_reasoning true to get reasons and sources."));
      }
      drill.appendChild(box);
    });
  }

  function draw() {
    drawFilters();
    drawBars();
    drawMatrix();
    drawDrill();
  }
  draw();
})();
