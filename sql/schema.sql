-- Omvendt indeks: hvilke enheter har oppgitt X som regnskapsfører (rollen REGN
-- i Enhetsregisteret). Enhetsregisteret har ikke dette oppslaget selv.
DROP TABLE IF EXISTS kunde;
CREATE TABLE kunde (
  regn_orgnr  TEXT NOT NULL,   -- regnskapsforetaket
  kunde_orgnr TEXT NOT NULL,   -- enheten som har oppgitt det som regnskapsfører
  PRIMARY KEY (regn_orgnr, kunde_orgnr)
);
-- Synken slår opp og sletter per kunde.
CREATE INDEX kunde_etter_kunde ON kunde (kunde_orgnr);

DROP TABLE IF EXISTS regnskapsforer;
CREATE TABLE regnskapsforer (
  orgnr          TEXT PRIMARY KEY,
  navn           TEXT NOT NULL,
  godkjenning    TEXT,
  antall_kunder  INTEGER NOT NULL
);

DROP TABLE IF EXISTS metadata;
CREATE TABLE metadata (
  nokkel TEXT PRIMARY KEY,
  verdi  TEXT NOT NULL
);
