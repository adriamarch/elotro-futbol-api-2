#!/usr/bin/env python3
"""Chequeo estático de paridad entre worker/src/index.js (principal, D1) y
worker-secondary/src/index.js (secundario, PostgreSQL).

Compara tres cosas y sale con código 1 si el secundario se queda atrás:
  1. Rutas /api/... escritas como literal ("/api/x").
  2. Rutas /api/... escritas como regex (path.match(/^\\/api\\/x\\/(\\d+)$/)),
     que la versión anterior de este script NO veía.
  3. Funciones de primer nivel (function nombre / const nombre = (...) =>).

Diferencias INTENCIONADAS (no son fallo): ver PERMITIDO_SOLO_SECUNDARIO y
PERMITIDO_SOLO_PRINCIPAL. Si añades una, explica el porqué en el comentario.
"""
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
main = (root / 'worker/src/index.js').read_text(encoding='utf-8')
sec = (root / 'worker-secondary/src/index.js').read_text(encoding='utf-8')

# Solo existen en el secundario a propósito (no se portan al principal aquí).
PERMITIDO_SOLO_SECUNDARIO = {
    # Cortacircuito por ruta del failover (KV). Vive solo en este archivo;
    # ver CAMBIOS-FASE1.md: decidir si debe portarse al Worker principal.
    'circuitoEstaAbierto', 'circuitoRegistrarExitoPrimario',
    'circuitoRegistrarFalloPrimario', 'claveCircuito', 'normalizarRutaParaCircuito',
}
PERMITIDO_SOLO_PRINCIPAL = set()


def rutas_literales(s):
    out = set()
    for m in re.finditer(r"['\"](/api/[^'\"]+)['\"]", s):
        out.add(re.sub(r'\\\\d\+', '{id}', m.group(1)))
    return out


def rutas_regex(s):
    out = set()
    for m in re.finditer(r"/\^?\\/api\\/([^/\n]*(?:\\/[^/\n]*)*?)\$?/[gimsuy]*", s):
        r = m.group(1)
        r = re.sub(r'\(\\d\+\)', '{id}', r)
        r = re.sub(r'\([^)]*\)', '{x}', r)
        r = r.replace('\\/', '/')
        out.add('/api/' + r)
    return out


def funciones(s):
    f = set(re.findall(r'^(?:export\s+)?(?:async\s+)?function\s+(\w+)', s, re.M))
    f |= set(re.findall(r'^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(', s, re.M))
    return f


fallos = 0
for etiqueta, fa, fb, perm_b, perm_a in (
    ('rutas literales', rutas_literales(main), rutas_literales(sec), set(), set()),
    ('rutas regex', rutas_regex(main), rutas_regex(sec), set(), set()),
    ('funciones', funciones(main), funciones(sec), PERMITIDO_SOLO_SECUNDARIO, PERMITIDO_SOLO_PRINCIPAL),
):
    falta = sorted((fa - fb) - perm_a)
    sobra = sorted((fb - fa) - perm_b)
    print(f'{etiqueta}: principal={len(fa)} secundario={len(fb)}')
    if falta:
        fallos += 1
        print(f'  FALTAN en el secundario ({len(falta)}):')
        for x in falta:
            print('   -', x)
    if sobra:
        print(f'  Solo en el secundario ({len(sobra)}) [revisar]:')
        for x in sobra:
            print('   +', x)

if fallos:
    raise SystemExit(1)
print('Paridad estática (rutas literales + regex + funciones): OK')
