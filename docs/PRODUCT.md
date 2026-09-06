# Produktový kontrakt v1

## Účel

Uživatel přidá vlastní zdroje a popíše, co chce dlouhodobě konzumovat. Siftera nabídne pohodlný multimediální proud zajímavých položek z poslední doby, které ještě nečetl, s historií a dohledatelnými originály (ADR-015). Úspěch znamená „jsem rád, že jsem to viděl“, užitečné objevy a méně opakování; čas v aplikaci a prokliky nejsou hlavní metriky.

## Schválená upřesnění

- Název Siftera. Dřívější Softera/MyFeed jsou zastaralé názvy.
- Každý člověk včetně dítěte má plnohodnotný samostatný účet, vlastní zdroje, preference, tokeny a historii. Žádný rodičovský vztah, rodinné sdílení, audience ID ani automatický přístup mezi účty.
- Škola je skupina/filtr zdrojů. Oznámení z režimu `all` se objeví v knihovně bez čekání na AI; AI je nesmí vyřadit kvótou.
- Zdroje si registruje uživatel. Objevování vybírá mimo obvyklá témata pouze uvnitř jeho zdrojů. Žádné skryté přidávání vydavatelů.
- AI rychle posuzuje relevanci, užitečnost, novost a vhodnou prezentaci. Neprovádí fact-checking ani rozsáhlé posuzování pravdivosti.
- První externí editor: lokální agentní CLI spuštěné ručně/cronem na zapnutém počítači. Hosted scheduler agenta a plný MCP OAuth až později.
- Plynulé pokračování do historie je možné; nový feed má viditelný konec a akci označit vydání jako přečtené.

## Hlavní scénáře

1. Dospělý přidá Hospodářské noviny, BBC, CNN, několik autorů Medium a technické blogy; nastaví zájmy a omezení. Agent vybere ráno např. 25 položek, z toho dva dlouhé texty a několik objevů.
2. Slabý clickbait obsahuje jedinou užitečnou informaci: vznikne krátká `distilled_fact` karta s originálem. Kvalitní analýza dostane `long_read` kartu a perex, který nevyzradí celý text.
3. Samostatný školní uživatel sleduje stránku třídy. Po ingestu vidí všechny nové příspěvky ve filtru Škola. AI může později doplnit úkoly či testy; nerozpoznaný termín zůstane neurčený.
4. Uživatel uloží článek offline; po připojení se akce synchronizuje. Hromadné přečtení ani otevření originálu nemění explicitní zájmy; při zapnutém `behaviorEnabled` smí být to, co uživatel viděl a nechal být, slabým signálem nezájmu pro editora (ADR-015), nikdy ne náhradou explicitních preferencí.
5. Externí editor jeden den neběží. Poslední vydání zůstane dostupné, UI ukáže stáří; nové zdroje a Škola se dál načítají.

## Rozsah MVP

Google login; CRUD zdrojů; RSS/Atom a konfigurovatelný HTML seznam/detail; deterministická extrakce; verze a deduplikace; levný předvýběr; API a remote MCP s revokovatelným tokenem; lokální stdio fasáda; redakční workflow s atomickým publikováním; preference a explicitní feedback; denní feed a historie; hledání a kombinovatelné filtry; read/saved/hidden; OPML import/export; instalovatelná PWA s posledním vydáním offline.

Renderery MVP: article, long_read, distilled_fact, school_notice, video, audio. Video podporuje YouTube embed na vyžádání, audio odkaz na epizodu/originální aplikaci (bez vlastního playeru). Nepodporovaný budoucí renderer má obecnou bezpečnou kartu s odkazem. Budoucí learning/discovery/book/movie/recommendation/short_fun se mají vejít do smlouvy bez změny identity a feedu.

MVP neznamená hotové konektory ke všem zmíněným značkám: RSS zdroje a veřejné podklady lze přidat; skutečný přístup k přihlášeným účtům má oddělené požadavky v [SOURCES](SOURCES.md).

## Non-goals

Vlastní ML recommender, embeddings, vector DB, autonomní hledání celého webu, fact-checking, chat nad článkem, generování videí, transkripce bez existujícího přepisu, rodičovská správa, task manager pro školu, push notifications, sociální interakce, paywall bypass, cookies v backendu, Netflix/ČSFD/Spotify-account API, newsletterová schránka, MCP OAuth server, centrální placená LLM služba, microservices, Kubernetes, Redis, obecný databázový framework a hotový self-hosted deployment.

## Produktové limity

Výchozí 50 zdrojů/uživatel, 300 nových kandidátů/den pro běžné zpracování, 80 pro AI předvýběr, 40 čtení, 25 cílových položek, nejvýše 50 redakčních položek/run. Nadbytek zdrojových položek zůstane ve frontě; limity nesmí beze stopy zahodit školní oznámení. Konečné nastavení a tvrdé stropy stanoví [AI_EDITOR](AI_EDITOR.md).

Při nedostatku kvalitního obsahu je feed kratší. Uživatel nikdy nedostane opakovanou položku jen kvůli naplnění kvóty. Celý článek nemusí být dostupný; UI to sdělí, nepředstírá přečtení.

## Ověření hodnoty

Před veřejným uvedením ručně projít 3–7 denních běhů na skutečných uživatelských zdrojích: zda výběr respektuje instrukce, neopakuje tutéž událost, zachová objevování a zda shrnutí vystihuje podstatu. Neposuzovat výsledek jen úspěšností JSON validace. Konkrétní redakční fixtures jsou v [TESTING](TESTING.md).
