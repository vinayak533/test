/* ============================================================================
   server/booking/format.js — dates, times and money as guests read them.
   Built by hand where the output must not depend on the server's ICU data.
   ============================================================================ */

"use strict";

const { formatDay, weekday } = require("../dates");

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* "Tue 20 Oct" */
function shortDay(day){
  const [, m, d] = day.split("-").map(Number);
  return `${SHORT_DAYS[weekday(day)]} ${d} ${SHORT_MONTHS[m - 1]}`;
}

/* "14:00" → "2:00 PM", "12:00" → "12:00 PM" (noon) */
function time12(hhmm){
  if (!hhmm || hhmm === "flexible") return "Not sure yet";
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}

/* Indian digit grouping: 128400 → "₹1,28,400". Paise only when present. */
function inr(amount){
  const n = Math.round(Number(amount) * 100) / 100;
  const neg = n < 0;
  const [whole, frac] = Math.abs(n).toFixed(2).split(".");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  const grouped = rest ? rest + "," + last3 : last3;
  return (neg ? "-" : "") + "₹" + grouped + (frac === "00" ? "" : "." + frac);
}

function plural(n, one, many){ return `${n} ${n === 1 ? one : (many || one + "s")}`; }

/* "1, 2 and 5" */
function list(items){
  const a = items.map(String);
  if (a.length <= 1) return a[0] || "";
  return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
}

/* Masks for showing a booking back to someone who proved they own it. */
function maskEmail(e){
  if (!e) return "";
  const [user, domain] = e.split("@");
  return (user.length <= 2 ? user[0] + "*" : user.slice(0, 2) + "*".repeat(Math.min(6, user.length - 2))) + "@" + domain;
}
function maskPhone(p){
  if (!p) return "";
  return p.slice(0, 3) + " " + "•".repeat(Math.max(0, p.length - 7)) + p.slice(-4);
}

module.exports = { formatDay, shortDay, time12, inr, plural, list, maskEmail, maskPhone };
