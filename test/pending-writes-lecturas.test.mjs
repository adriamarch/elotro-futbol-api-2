import test from "node:test";
import assert from "node:assert/strict";
import { debeEncolarse } from "../src/pending-writes.js";

test("el historial de lectura de lectores no se encola (ni POST, ni DELETE, ni DELETE por id)", () => {
  assert.equal(debeEncolarse("POST", "/api/readers/me/historial"), false);
  assert.equal(debeEncolarse("DELETE", "/api/readers/me/historial"), false);
  assert.equal(debeEncolarse("DELETE", "/api/readers/me/historial/12"), false);
});

test("las noticias guardadas y la fusión con la cuenta SÍ se encolan", () => {
  assert.equal(debeEncolarse("POST", "/api/readers/me/guardadas"), true);
  assert.equal(debeEncolarse("DELETE", "/api/readers/me/guardadas/7"), true);
  assert.equal(debeEncolarse("POST", "/api/readers/me/lecturas/sincronizar"), true);
});

test("los GET nunca se encolan y no se rompen otras rutas excluidas", () => {
  assert.equal(debeEncolarse("GET", "/api/readers/me/guardadas"), false);
  assert.equal(debeEncolarse("POST", "/api/readers/login"), false);
  assert.equal(debeEncolarse("POST", "/api/comments"), true);
});
