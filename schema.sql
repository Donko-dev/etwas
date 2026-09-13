-- ============================================================================
-- ETWAS — Schéma MySQL (remplace Google Sheets / Apps Script).
-- ============================================================================
-- À exécuter UNE FOIS sur ta base Hostinger (phpMyAdmin ou CLI mysql) avant
-- de démarrer EtwasServer.js. Toutes les tables utilisent InnoDB (transactions
-- + clés étrangères réelles) et utf8mb4 (emojis, accents, tous alphabets).
--
-- Avec un vrai schéma SQL, la "tolérance aux colonnes manquantes" qu'exigeait
-- Google Sheets (_col / _colOptional dans l'ancien AppsScript_v5.gs) devient
-- inutile : une colonne définie ici EXISTE toujours. C'est une vraie
-- simplification, pas une régression.
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------------------------------------------------------
-- COMPTES ETWAS (identité unique, Trial 1€/30j, abonnement) — Etwas Pro ET
-- Etwas ADS partagent le même compte (voir cahier des charges "compte unique").
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  etw_id                 VARCHAR(32)   NOT NULL PRIMARY KEY,   -- format ETW-XXXX-XXXX-XXXX
  company_name           VARCHAR(190)  NOT NULL DEFAULT '',
  trial_expires_at       BIGINT        NULL,                   -- timestamp Unix (ms), NULL = jamais activé
  subscription_expires_at BIGINT       NULL,
  owner_token            VARCHAR(64)   NULL,                   -- jeton propriétaire (Etwas ADS), migré depuis Apps Script
  created_at             BIGINT        NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- ANTI-REJEU — une transaction externe (KKiaPay/Plisio/Stripe/PayPal) ne peut
-- être appliquée qu'UNE seule fois, quelle que soit la passerelle.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_transactions (
  tx_key       VARCHAR(190) NOT NULL PRIMARY KEY,  -- ex: "kkiapay:abc123"
  gateway      VARCHAR(20)  NOT NULL,
  etw_id       VARCHAR(32)  NULL,
  purpose      VARCHAR(20)  NOT NULL,               -- trial | subscription | boost
  processed_at BIGINT       NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- CHAÎNE GoBD (Etwas Pro) — immuabilité comptable, chaînage SHA-256.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_chain (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  etw_id        VARCHAR(32)  NOT NULL,
  seq           INT          NOT NULL,
  hash          CHAR(64)     NOT NULL,
  prev_hash     VARCHAR(64)  NOT NULL,               -- "GENESIS" pour la toute première ligne
  payload_json  LONGTEXT     NOT NULL,
  created_at    BIGINT       NOT NULL,
  UNIQUE KEY uniq_etw_seq (etw_id, seq),
  INDEX idx_etw_id (etw_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- BOUTIQUES (Etwas ADS) — remplace l'onglet "Boutiques" du Google Sheet.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boutiques (
  id                VARCHAR(36)  NOT NULL PRIMARY KEY,  -- UUID
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  nom               VARCHAR(190) NOT NULL,
  categorie         VARCHAR(120) NOT NULL,
  pays              VARCHAR(10)  NOT NULL DEFAULT '',
  ville             VARCHAR(120) NOT NULL DEFAULT '',
  adresse           VARCHAR(255) NOT NULL DEFAULT '',
  contact           VARCHAR(40)  NOT NULL DEFAULT '',
  description       TEXT         NOT NULL,
  devise            VARCHAR(6)   NOT NULL DEFAULT 'XOF',
  logo              LONGTEXT     NULL,                  -- image encodée en base64 (comme dans Sheets)
  boost             TINYINT(1)   NOT NULL DEFAULT 0,
  boost_expiration  DATETIME     NULL,
  owner_token       VARCHAR(64)  NOT NULL DEFAULT '',
  suspendue         TINYINT(1)   NOT NULL DEFAULT 0,
  raison_suspension VARCHAR(255) NOT NULL DEFAULT '',
  latitude          DECIMAL(9,6) NULL,                  -- coordonnées PUBLIQUES de la boutique uniquement
  longitude         DECIMAL(9,6) NULL,
  INDEX idx_owner_token (owner_token),
  INDEX idx_boost (boost, boost_expiration)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- ANNONCES (Etwas ADS) — remplace l'onglet "Annonces".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS annonces (
  id                 VARCHAR(36)  NOT NULL PRIMARY KEY,
  boutique_id        VARCHAR(36)  NOT NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lien               VARCHAR(500) NOT NULL DEFAULT '',
  description        LONGTEXT     NOT NULL,
  prix               DECIMAL(14,2) NULL,
  prix_promo         DECIMAL(14,2) NULL,
  prix_mode          VARCHAR(20)  NOT NULL DEFAULT 'nonbarre',
  contact            VARCHAR(40)  NOT NULL DEFAULT '',
  plan               VARCHAR(20)  NOT NULL DEFAULT '',
  plan_weight        INT          NOT NULL DEFAULT 0,
  expiration         DATETIME     NULL,
  txn_id             VARCHAR(190) NOT NULL DEFAULT '',
  owner_token        VARCHAR(64)  NOT NULL DEFAULT '',
  suspendue          TINYINT(1)   NOT NULL DEFAULT 0,
  raison_suspension  VARCHAR(255) NOT NULL DEFAULT '',
  masquer_boutique   TINYINT(1)   NOT NULL DEFAULT 0,
  collecter_adresse  TINYINT(1)   NOT NULL DEFAULT 0,
  slug               VARCHAR(190) NOT NULL DEFAULT '',
  faq_json           LONGTEXT     NULL,
  seo_keywords       VARCHAR(500) NOT NULL DEFAULT '',
  FOREIGN KEY (boutique_id) REFERENCES boutiques(id) ON DELETE CASCADE,
  INDEX idx_boutique (boutique_id),
  INDEX idx_expiration (expiration),
  INDEX idx_slug (slug),
  INDEX idx_txn (txn_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Images d'annonce — table à part plutôt que 10 colonnes Image1..Image10
-- (design relationnel propre : jusqu'à 10 lignes par annonce, position 0-9).
CREATE TABLE IF NOT EXISTS annonce_images (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  annonce_id   VARCHAR(36) NOT NULL,
  position     TINYINT     NOT NULL,          -- 0 à 9
  data_base64  LONGTEXT    NOT NULL,
  FOREIGN KEY (annonce_id) REFERENCES annonces(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_annonce_position (annonce_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- COMPTABILITÉ TVA — remplace l'onglet "Comptabilite" (créé automatiquement
-- par l'ancien Apps Script au premier abonnement payé).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compta_tva (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  vendeur_id      VARCHAR(64)  NOT NULL DEFAULT '',
  forfait         VARCHAR(60)  NOT NULL DEFAULT '',
  pays_client     VARCHAR(10)  NOT NULL DEFAULT '',
  montant_ht      DECIMAL(14,2) NOT NULL DEFAULT 0,
  taux_tva        DECIMAL(5,2)  NOT NULL DEFAULT 0,
  montant_tva     DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_ttc       DECIMAL(14,2) NOT NULL DEFAULT 0,
  txn_id          VARCHAR(190) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- BOÎTE À SUGGESTIONS — remplace l'onglet "Suggestions".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suggestions (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  module     VARCHAR(20) NOT NULL DEFAULT 'inconnu',
  etw_id     VARCHAR(32) NULL,
  message    TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
