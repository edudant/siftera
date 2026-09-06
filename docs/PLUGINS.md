# Vstupní konektory

`@siftera/connectors` převádí způsoby, jak se článek dostane do Siftery, na malé normalizované `IngestInput` z core. Nezná uživatele, repository, redakční preference ani UI. Aplikační vrstva určí ověřeného uživatele, vezme jeho registrovaný Source a výsledky předá do `EditorialService.ingest`.

## Veřejné rozhraní

```ts
import {
  createDefaultConnectorRegistry,
  SafeHttpClient,
  type DefaultConnectorRequests,
} from "@siftera/connectors";

const registry = createDefaultConnectorRegistry({ http });
const result = await registry.collect("rss", { sourceId, sourceName, url });
// result.inputs: NormalizedIngestInput[]
// result.complete: false when the source was capped and scheduling must continue it
```

`manual` přijímá potvrzené `url`, volitelný `title`, `text`, `excerpt`, datum a kategorie. Nic nestahuje: URL se jen ověří a text se převede na plain text. To dává UI možnost nechat člověka potvrdit vložení odkazu bez skrytého načítání URL.

`rss` načte RSS 2 nebo Atom a vrátí nanejvýš 100 položek. RSS GUID/Atom ID je `externalId`, relativní Atom link se řeší vůči `xml:base` nebo feed URL. Feedový HTML popis či obsah se ukládá pouze jako plain text s `access: partial`; krátký `description` se nevydává za celý článek. Pokud je více položek než limit, `complete` je `false`, takže budoucí scheduler musí uložit continuation a zdroj neoznačit za hotový.

Nový vstup se přidává implementací `InputConnector<Request>`, registrací stabilního `kind` do `ConnectorRegistry` a mapováním na `NormalizedIngestInput`. Konektor nesmí vytvářet FeedRun ani LibraryItem, hodnotit relevanci, volat AI nebo importovat UI. Případná změna uloženého `Source.config` patří nejprve do schváleného sdíleného kontraktu; samotný vstupní plugin ho měnit nemusí.

## Síťová hranice

`SafeHttpClient` má povinně injektované `fetch` a `resolveHost`. Před každým requestem i každým redirectem odmítá URL s credentials, jiným schématem než HTTP(S), jiným portem než 80/443, localhost/metadatové hostname a neveřejné IPv4/IPv6 odpovědi. Redirecty jsou manuální (nejvýše pět), request má výchozí limit 15 sekund a tělo je streamově omezené na 5 MiB. Povolené jsou jen HTML/XML media typy; XML s DTD nebo entitami se odmítne před parsováním.

Balíček nezavádí socketovou knihovnu, aby šel použít také ve Workers. Node adapter však musí `resolveHost` svázat se skutečným připojením (například kontrolovaným dispatcher/lookup); samotný DNS preflight a potom běžný `fetch` není ochrana proti DNS rebindingu. Worker runtime musí dodat odpovídající egress/DNS politiku. Integrace nesmí posílat cookies, authorization nebo uživatelské URL credentials.

## Záměrné mezery M2b

Nejsou zde OPML, source CRUD, scheduler/lease, HTML seznam/detail pro školní weby, conditional request metadata (ETag/Last-Modified), robots/rate-limit policy ani on-demand fulltext fetch/cache. Tyto kroky patří samostatně do M2c nebo dalšího vymezeného M2b úkolu. Adaptér také neposuzuje paywall a nepokouší se ho obejít.
