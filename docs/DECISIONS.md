# Architektonická rozhodnutí (ADR)

Status accepted, v1, 2026-09-06. Tento soubor uzavírá doporučené volby; změny vyžadují konkrétní důvod a dopad, nikoli opakované obecné porovnávání stacků.

## ADR-023 Podcast se otevírá tam, kde ho uživatel poslouchá

Otevírat epizodu na stránce zdroje je u podcastu skoro vždy špatně: uživatel poslouchá ve Spotify, kde má rozposlouchané epizody i historii. Kanonická adresa navíc u některých feedů nevede k přehrávání vůbec — Anchor v `<link>` posílá adresu, která se přesměruje do **creator dashboardu** Spotify, tedy do rozhraní pro autory.

Karta audio položky proto míří do Spotify: tapnutí i nadpis vedou tam a přidané tlačítko to říká nahlas. Stránka zdroje zůstává dostupná pod „···", protože u některých podcastů (mujRozhlas) nese poznámky, přepis nebo odkazy z epizody.

Cíl se skládá ve dvou deterministických úrovních. Když položka nese `media` s `provider=spotify`, jde se přímo na `open.spotify.com/episode/<id>`. Jinak na `open.spotify.com/show/<id>` podle `spotifyShowId` zdroje — pořad, kde je nejnovější epizoda nahoře. Obojí je univerzální odkaz, který na mobilu otevře aplikaci.

**Vyhledávací odkaz se nepoužívá**, i když to byla první úvaha. Ověřeny tři formy a žádná neobstála: `/search/<dotaz>/episodes` trefuje epizodu na webu, ale mobilní aplikace bere jako dotaz poslední segment cesty, takže hledala slovo „episodes"; bez té záložky je dotaz pro aplikaci správně, ale výsledky jdou do „Vše", kde u českých názvů vyhrává hudba (na „Volby v Praze Liberální vybíjená…" vyskočí Daniel Landa); a fráze v uvozovkách zabere jen u některých názvů. Mobilní **webový** přehrávač route `/search` ignoruje úplně. Ranking cizí služby není nic, na čem se dá postavit odkaz.

Epizodní ID dohledává **lokální ingest** proti Spotify Web API (client credentials), ne Worker: klíče zůstávají na stroji, kde běží sběr, stejně jako u AI fáze (ADR-005). Pořad se dohledá jednou za zdroj a uloží se do jeho konfigurace; epizoda se páruje podle názvu proti seznamu epizod pořadu (přesná shoda, jinak zanoření jednoho názvu do druhého) — ne globálním vyhledáváním, které by mohlo trefit cizí pořad. Když se epizoda nenajde, zůstane `media` od konektoru (přímý zvukový soubor) a klient otevře pořad; nikdy se nehádá. Odkaz na pořad je zároveň to, co dostanou položky vydané dřív: vydání jsou nemměnná (ADR-010), takže epizodní ID k nim už nedoplníme.

Nabídka se řídí konfigurací zdroje, ne doménou feedu: hostitel nic neříká (Zeitgeist je na Anchoru, Na Východ! na mujRozhlas, oba na Spotify jsou), a placená exkluzivita jako HeroHero tam naopak není. Skupina `spotify` je **záměr** („tenhle podcast na Spotify hledej"), `spotifyShowId` je **dohledaný fakt** a teprve on rozhoduje, jestli se tlačítko zobrazí. Čte se z **živé** konfigurace zdroje, protože zmrazené `groups` ve vydání by změnu nezachytily. Konektor u zvukového enclosure zapisuje `medium=audio` a `media` s délkou z `itunes:duration`, takže karta umí říct, jestli jde o čtvrt hodiny nebo pět hodin.

## ADR-022 Video se přehrává ve feedu, ale až na kliknutí

Odchod na originál je u článků nutnost — cizí web se do iframu vložit nedá, protože si to zakazuje sám (`X-Frame-Options`). YouTube je výjimka: embed nabízí oficiálně, takže u videa není důvod feed opouštět. Karta proto přehrává na místě.

Vloženo je to jako **fasáda**: dokud uživatel nezmáčkne přehrát, na přehrávač nejde ani jeden request — v kartě leží jen náhled, který stejně nese už samotná položka. Po kliknutí se vloží iframe na `youtube-nocookie.com`. Sledování tak zůstává důsledkem volby, ne důsledkem otevření feedu; to je stejná úvaha, jako proč Siftera nemá analytiku. Hraje vždycky nejvýš jedno video: který přehrávač je živý, drží proud karet, takže spuštěním dalšího ten předchozí zmizí i se zvukem.

Spuštění videa se počítá jako přečtení, stejně jako rozbalení textu (ADR-015) — a protože se nikam neodchází, nemusí se u videa vůbec obnovovat pozice ve feedu. Video také nesmí skončit jako náhled v kompaktním řádku, takže `emphasis=compact` se u něj překlápí na standardní kartu.

Identifikátor videa nese kontrakt: konektor rozpozná YouTube podle `yt:videoId` i podle kanonické adresy a zapíše `medium=video` a `media={provider,externalId,url,durationSeconds}`, ingest to propouští dál. Vydané položky jsou ale nemměnné (ADR-010), takže starší vydání `media` nikdy nedostane — pro ně klient identifikátor odvodí z kanonické adresy a přijme jen jedenáctiznakový tvar, aby se do embedu nedostal cizí vstup. Spotify a ostatní podcasty tímhle nekončí u přehrávače: audio z enclosure by šlo hrát nativně přes `<audio>`, ale to je vlastní rozhodnutí, ne rozšíření tohoto.

## ADR-021 Kanály jako ikony, režim uvnitř kanálu

7. 9. se ukázalo, že tři textové taby (Výběr / Vše / Uložené) míchají dvě různé otázky: *co* čtu a *jak* to čtu. Uživatel chce brouzdat po oblastech — zprávy, technika, podcasty, video — a v každé z nich se rozhodnout, jestli vidí jen nepřečtené, nebo celý archiv. Do budoucna k nim mají přibýt i pracovní přehledy (například otevřené merge requesty), kde je „oblast" ještě zřetelnější.

Horní lišta proto nese **kanály jako ikony**: Přehled, uživatelské kategorie z preferencí a Uložené. Kategorie dostala nepovinné pole `icon` z uzavřeného seznamu (`news`, `tech`, `podcast`, `video`, `science`, `work`, `star`, `world`), takže lišta drží jeden výtvarný jazyk a text jmenovky slouží jen jako podpis. Řada se vodorovně roluje; přidání kanálu tedy nic nerozbije. **Režim Feed / Vše patří dovnitř kanálu** — Feed je nepřečtený proud po předvýběru (ADR-015), Vše celý archiv kanálu včetně přečteného a toho, co redakcí neprošlo. Řazení a filtr na jednotlivý zdroj zůstávají v panelu pod ikonou, ale filtr zdrojů se teď omezuje na zdroje aktivního kanálu; kategorie z panelu zmizela, protože se z ní stal kanál. „Výběr" se jmenuje **Feed**.

Karta zveřejnila tagy: byly schované v rozbalení, přitom je to nejrychlejší způsob, jak poznat, o čem položka je. „Zobrazit víc" naopak pokračuje v textu jako na Facebooku a nic dalšího neodhaluje — vysvětlení „proč to vidím" a použitý podklad se přesunuly do nabídky pod „···", kam patří jako doplňková informace. Odkaz „Zobrazit víc" nesmí být uvnitř zkráceného odstavce (clamp ho odstřihne i s ním) a ukazuje se jen tehdy, když text opravdu přetéká.

Pracovní kanály zůstávají zatím jen připraveným místem: ikona `work` existuje, konektor ne. Merge requesty se mění v čase, nemají projít redakčním shrnutím a „přečteno" u nich znamená něco jiného než u článku — to je vlastní rozhodnutí, ne rozšíření tohoto.

## ADR-020 Bootstrap se dělí, ingest dávkuje

7. 9. produkce přestala fungovat: bootstrap vracel trvale 503 s chybou Cloudflare 1102, tedy vyčerpání zdrojů Workeru. Bezplatný plán dává 10 ms CPU na request a bootstrap dělal v jednom volání příliš mnoho — prefilter nad stovkami kandidátů, skórování proudu, celou knihovnu i celý inbox, a nakonec serializaci přes 300 kB. Počet dotazů do D1 zůstal díky ADR-019 konstantní, ale CPU práce roste s objemem dat, což samotné dávkové čtení neřeší.

Čekající a skryté položky proto dostaly vlastní `GET /pending` a UI si je stahuje teprve v režimu Vše. Bootstrap spadl na 76 kB a odpovídá stabilně; `/pending` nese zbytek. Rozdělení má i tu výhodu, že první vykreslení feedu nečeká na data, která uživatel většinou nechce vidět.

**Podruhé, 7. 9.:** s knihovnou o 55 vydaných položkách se bootstrap dostal na 234 kB a začal padat znovu — pět z šesti pokusů vrátilo 503, tedy aplikace v produkci nefungovala. Ze stejného důvodu jako u čekajících položek dostal vlastní endpoint i archiv (`GET /library`). Bootstrap tak nese preference, proud nepřečteného a zdroje (131 kB, 10 z 10 pokusů v pořádku) a archiv se dotahuje teprve pro režim Vše, Uložené, kategorie a hledání. Pořadí je záměrné: první vykreslení feedu nemá čekat na data, která uživatel ve výchozím pohledu nevidí. Hranice se ale bude blížit dál a `unreadStream` roste s počtem vydaných položek, takže dalším krokem bude stránkování proudu, ne další dělení.

Stejná hranice se ukázala u zápisu: dávka 25 položek přes `POST /ingest` procházela nespolehlivě (jednou 200 za 4 s, jinak 1102). Lokální ingest proto posílá po pěti položkách a na 503 nebo 429 opakuje s narůstajícím odstupem. Po této změně prošlo všech 24 zdrojů bez chyby. Placený plán (30 s CPU) by obojí problém odstranil, ale prototyp má zůstat provozovatelný zdarma.

## ADR-019 Produkční Worker: token, CORS a ingest zvenčí

6. 9. potvrzen cílový tok GitHub Pages → Cloudflare Worker → D1/R2, se sběrem RSS a AI v lokálním procesu. Před nasazením se ukázaly tři překážky, všechny změřené na běžícím Workeru.

**Dotazy do D1.** Jeden bootstrap dělal 661 dotazů a rostl lineárně s počtem kandidátů — `prefilter` i bootstrap se ptaly zvlášť na stav a metadata zdroje pro každou položku. To naráží na limit dotazů na request i na latenci. Port `RepositoryRead` proto dostal dávkové čtení (`listStates`, `listSourceMetadata`, `listEditorialItems`) a horká místa je používají. Výsledek: 38 dotazů konstantně bez ohledu na objem dat, odezva ze ~300 ms na ~38 ms.

**Identita.** Dosavadní `resolvePrincipal` bral UID z hlavičky, kterou si klient nastaví sám; to bylo bezpečné jen za Sites dispatcherem. Bez něj by veřejný Worker byl otevřenou databází. Identitu proto nese sdílené tajemství v `Authorization: Bearer`, porovnávané v konstantním čase, a UID vlastníka je serverová konfigurace. Token v UI zadá uživatel a drží ho prohlížeč; pro jeden účet to stačí a nevyžaduje to OAuth. Kdo token získá, má plný přístup — víc účtů bude chtít skutečné přihlášení.

**Cross-origin.** UI na Pages a API na Workeru jsou dvě domény, takže bylo potřeba doplnit CORS i preflight. Dosavadní same-origin CSRF kontrola by z Pages odmítla všechny zápisy; nahradil ji allowlist originů. S tokenem v hlavičce CSRF nehrozí, protože prohlížeč cizí požadavek nepodepíše.

Worker přestává stahovat RSS: `collect` přijímá jen ruční vstup a nový `POST /ingest` bere připravené dávky (max 100 položek). Sběr běží v `pnpm ingest:once`, kde na CPU čas ani subrequesty nejsou limity edge runtime. Ruční vložení odkazu zůstává, protože nic zvenčí nestahuje.

## ADR-018 GitHub Pages a veřejná ukázka

Uživatel přešel na jiný ChatGPT účet a výslovně nahrazuje Sites nasazením na GitHub Pages. První Pages varianta hostuje statické UI a veřejný sanitizovaný ukázkový feed odvozený z dev. Čtenářské stavy, preference a ruční vstupy se ukládají pouze v konkrétním prohlížeči; nejde o sdílenou privátní serverovou databázi. RSS sběr a dvoustupňová AI redakce s doplněním originálů zůstávají v lokálním backendu. Pages se nesmí tvářit, že umí obejít CORS nebo hostovat Worker; tyto akce jasně vyžadují backend. Oddělení api adapteru zachová cestu k pozdějšímu samostatnému API. Testovací feed obsahuje pouze veřejné článkové metadata a krátké redakční výstupy, žádné uživatelské identity, privátní instrukce ani plná těla článků.

## ADR-017 Dvoustupňová redakce nad uloženými články

Redakce pracuje nad uloženými kandidáty; sběr zdrojů stále nevolá AI. Levný deterministický předvýběr nabízí nejvýše80 kandidátů se stářím, read/seen/saved/hidden a zdrojem. Editor nejprve vybírá shortlist pro podrobné čtení (výchozí doporučení12); může jej změnit. Na jeden run lze načíst nejvýše20 originálů, po dávkách maximálně4. URL pochází výhradně z kandidáta ve snapshotu. Žádné hledání dalších odkazů, cookies nebo obcházení paywallů. Deterministická extrakce odstraňuje skrytý obsah a vrací full/partial/unavailable; detekovaný paywall vždy znamená partial. Chyba originálu neblokuje ostatní kandidáty ani publikaci z RSS výňatku.

Výsledky čtení se ukládají k runu, stejný požadavek je neopakuje a změna revize je odmítnuta. Neúplný text se smí použít pro poctivé shrnutí s basis=excerpt, nikdy pro distilled_fact nebo long_read. Plný text vyžaduje serverový receipt. Editor dostává nedávná publikovaná doporučení a známá témata pro kontinuitu; kategorie nadále definuje uživatel jako filtry. Saved znamená uložené na později, nikoli explicitní like nebo automatický zájem o všechna podobná témata. RecentlyIgnored nesmí zahrnovat saved položky.

Finální výsledek řadí editor od nejzajímavějšího, až50 položek v několika dávkách po10. Server ověří celý vstup před přijetím dávek, publikuje jednou; idempotentní opakování importu pokračuje po přijatých dávkách. Pořadí proudu nadále kombinuje AI relevanci se stářím a seen podle ADR-015. Automatické volání placeného LLM API se nezavádí; externí klient používá export → shortlist → doplnění originálů → finální import. Runner zůstává volitelný lokální executable.

## ADR-016 Jeden feed s režimy a uživatelskými kategoriemi

6. 9. uživatel zrušil dělení Dnes vs. Knihovna: je to jeden feed, ve kterém se přepíná pohled. Výchozí je redakční výběr (proud podle ADR-015). Vedle něj režim **Vše**, který ukáže i nasbírané položky, jež redakcí neprošly — tím se z Inboxu stává jen jiný pohled na tatáž data a jako samostatná obrazovka zaniká. Spodní navigace se zkracuje na **Feed · Uložené · Nastavení**; ruční vložení odkazu se přesouvá pod „+“ v horní liště.

Kategorie **nedefinuje AI editor, ale uživatel**. Zvažovala se pevná sada v kontraktu, po které by editor musel sahat, a byla odmítnuta ve prospěch uživatelského řešení: kategorie je pojmenovaný filtr nad tématy a zdroji, který si člověk sám složí („Technika = zdroj Root.cz a témata linux, ai, programovani“). Důvod je měřený — editor si témata vymýšlí volně a na 40 publikovaných položek jich vzniklo 55, z toho 39 s jedinou položkou; jako filtr jsou nepoužitelná a pevná sada by zase nutila editora tlačit obsah do škatulek, které nemusí sedět. Uživatelská kategorie nemění kontrakt editora, funguje na už publikovaných datech a dá se kdykoli přepsat. Kategorie žijí v preferencích, takže je editor v jobu vidí jako doplňkovou informaci o tom, co uživatele zajímá.

Řazení a filtry jsou v panelu za ikonou, režim v tabech: to, co se přepíná často, zůstává vidět, zbytek nezabírá výšku. Hlavička není trvale přilepená — při rolování dolů odjede a při prvním pohybu zpět nahoru se hned vrátí, aby ovládání bylo po ruce bez trvalé daně na výšce obrazovky.

Feed se dočítá postupně po patnácti položkách. Sentinel musí být poslední prvek proudu — první pokus ho měl nad sekcí čekajících položek a rychlý scroll ho přeskočil, takže se nedočetlo nic; čekající se proto vykreslují jako pokračování téhož stránkovaného seznamu, ne jako samostatná sekce pod ním. Poslední odpověď bootstrapu se drží v `sessionStorage` a při startu se vykreslí okamžitě, zatímco na pozadí doběhne čerstvá: odchod na originál aplikaci načte znovu a bez cache by návrat čekal na síť. Spolu s daty se obnovuje i pohled na feed a počet dočtených položek, jinak by se scroll neměl kam vrátit. `sessionStorage`, ne `localStorage` — jde o osobní feed a má zmizet se zavřením karty.

Jméno zdroje se v kartě řeší z aktuální konfigurace, ne z provenance: ta ho nese zmrazené od publikace a u starších vydání to může být celá URL. Když i tak vyjde adresa, zobrazí se jen doména, a popisek se zkracuje na jeden řádek.

## ADR-015 Proud nepřečteného místo denního vydání, dvoustupňové čtení

6. 9. uživatel odmítl model „každý den nové vydání“: nechce novinky dne, ale zajímavé položky z poslední doby, které ještě nečetl. Změřeno na skutečných datech, že současný model to nedokáže — `latestFeed` vrací jen poslední run, takže z 40 publikovaných položek bylo 10 v Dnes a **24 nepřečtených propadlo do Knihovny**, kde ležely mezi přečtenými. Kdo den nečte, o ten výběr přijde.

Hlavní obrazovka proto přestává být vydání a stává se proudem: publikované položky napříč runy, které nejsou přečtené ani skryté a nejsou starší než 14 dní. Po 14 dnech položka z proudu vypadne a zůstane dohledatelná v knihovně — nepřečtené se nemá hromadit do dluhu, který už nikdo nedočte. Řadí se skóre relevance od editora s útlumem podle stáří, aby čerstvé a zajímavé bylo nahoře a starší průměrné padalo samo dolů; bez útlumu by stará vysoko hodnocená položka uvízla navrchu napořád. `FeedRun` zůstává podle ADR-010 neměnný a dál nese idempotenci importu i historii — mění se jen to, co UI čte, ne jak se publikuje.

Čtení má nově dva stupně. **Viděno** nastaví klient, když karta byla aspoň z poloviny ve viewportu déle než vteřinu; položka nemizí, jen klesá v pořadí pod ty, které uživatel nikdy neměl před očima. **Přečteno** zůstává explicitní: otevření originálu nebo rozbalení karty. Třetí stupeň — „měl to dlouho na obrazovce, tedy o to nestál“ — byl zvážen a odmítnut: doba zobrazení je u jednoho uživatele příliš zašuměná (odložený telefon, přerušení) a velké platformy ji unesou jen průměrováním přes miliony lidí. Rozlišit „neviděl“ od „proletěl“ spolehlivé je, rozlišit „proletěl“ od „odbyl“ nikoli.

Tím se vědomě mění dřívější produktové pravidlo. [PRODUCT](PRODUCT.md) říkal, že prokliky a čas v aplikaci nejsou metriky a že přečtení nemění explicitní zájmy; `behaviorEnabled` byl proto výchozím vypnutý. Uživatel 6. 9. rozhodl, že signál „viděl jsem to a nezareagoval“ **smí** vstoupit i do redakčního zadání jako slabý signál nezájmu, nejen do řazení vlastního proudu. Zapnutí zůstává v rukou uživatele přes `behaviorEnabled`; při vypnutém příznaku se signál sbírá jen pro pořadí a do jobu se neposílá.

Signál se do jobu posílá jako `recentlyIgnored` — nedávno **vydané** položky, které uživatel viděl a nepřečetl, s tématem a zdrojem. První návrh připojoval příznak ke kandidátům v jobu a byl slepý: kandidát ještě nebyl publikovaný, takže ho uživatel nemohl vidět, a příznak byl vždy prázdný. Editor má signál používat na úhel a opakování — když podobná zpráva prošla bez zájmu, sáhnout po jiném úhlu — nikoli na vyřazení tématu nebo zdroje. Zůstává v platnosti, že jde o slabý a zašuměný signál: nesmí přebít explicitní preference ani vytvořit smyčku, kde se přestane nabízet celé téma jen proto, že uživatel několik dní scrolloval rychle.

## ADR-014 Vizuální feed místo čtečky, bez sociálního rozměru

6. 9. uživatel odmítl dosavadní vzhled jako „RSS čtečku" a požaduje look & feel Instagramu, Facebooku a TikToku — **výslovně bez sociálních prvků**. Žádné komentáře, lajky viditelné druhým, sdílení, profily, sledující ani jakýkoli signál od jiných lidí. Siftera zůstává jednouživatelský prostor; převzat je vizuální a ovládací jazyk, ne sociální mechanika. Existující stavy read/save/hide se nepřeznačují na „engagement" a nikam se neodesílají.

Zvolen je souvislý obrazový feed: karta bez rámečku, plynulý scroll, akce dole. Fullscreen snap-scroll typu TikTok byl zvážen a odmítnut — jedna zpráva na obrazovku je pro denní výběr 10 položek příliš pomalá. Barevný režim se řídí systémem, nikoli natvrdo tmavým podkladem.

První pokus o tento feed ještě četl jako čtečka a uživatel to 6. 9. odmítl. Rozbor proti Facebooku a Instagramu ukázal, že za dojmem stojí konkrétní prvky, ne celkové rozvržení: patkové nadpisy, zdroj bez tváře, hlavička vydání, absolutní datum a odstavcový perex. Proto se přechází na bezpatkovou typografii (serif zůstává jen u `distilled_fact`), zdroj dostává kruhový avatar z favicony s monogramem jako fallback, hlavička vydání mizí ve prospěch tiché poznámky nad proudem a čas je relativní. Karta se navíc rozbaluje na místě: „Zobrazit víc“ na konci věty ukáže celé shrnutí, témata a proč byla položka vybrána, aniž by se odcházelo z feedu — to nahrazuje zrušený detail.

Ovládání se stěhuje do hlavičky karty: uložit zůstává vidět, ostatní jde pod „···“. Přečteno mezi viditelné akce nepatří, protože se řídí samo — nastaví ho otevření originálu i rozbalení, a ruční přepnutí je jen oprava. Tap na kartu vede na originál, ale až při čistém tapnutí; posun prstu nad10px nebo držení nad500ms se bere jako rolování, jinak by se z aplikace odcházelo omylem při scrollu. Nadpis zůstává skutečným odkazem, aby cíl nebyl dostupný jen gestem. Stavové akce načítají data tiše: dřívější plný reload se skeletonem shazoval rozbalení a probliknul celý proud. Zástupný barevný gradient místa chybějícího obrázku se ruší; předstírá obsah, který nemáme, a textová karta je poctivější.

Obrazový feed vyžaduje obrázky, které dosud nikde nekončily: RSS konektor `<enclosure>` a `media:*` vůbec nečetl a `EditorialService.ingest` navíc zahazoval `image`/`media` natvrdo na `null`, přestože `IngestInput` i `Candidate` je nesou. Obojí se opravuje; jde o doplnění existujícího kontraktu, ne o jeho změnu. Obrázky se nehostují ani neproxují — načítají se přímo z původní domény jako `loading="lazy"` a `referrerpolicy="no-referrer"`, aby se čtenářské návyky neposílaly do zdrojů v Refereru. Zdroje bez obrázků (ověřeno na ČT24) musí zůstat plnohodnotné: fallback je typografická karta, ne prázdné místo.

Feed není jedna karta opakovaná dokola. Důraz položky (`emphasis`: `lead`/`standard`/`compact`/`text`) určuje AI editor, protože jako jediný ví, jestli obraz k obsahu něco přidává; pole je volitelné a bez něj si klient důraz odvodí z prezentace a hodnocení, takže starší vydání zůstávají platná. Zdroj má nad obrazem poslední slovo přes `imageMode` (`auto`/`large`/`small`/`none`) — ověřeno 6. 9., že Novinky a Seznam Zprávy neposílají obrázky vůbec, Aktuálně.cz posílá fotky 870×580 a iROZHLAS náhledy 160×107. Náhled pod 480 px se proto nikdy neroztahuje přes celou šířku: klient si po načtení změří skutečnou šířku a degraduje kartu na malý náhled, protože feedy `width` skoro nikdy neuvádějí.

Vlastní detail položky se ruší. Bez plného textu neobsahoval nic, co není na kartě, a byl to jen mezikrok navíc. Klik proto vede rovnou na originál, **ve stejné kartě** — uživatel se vrací tlačítkem zpět a nezavírá karty. V nainstalované PWA to na Androidu znamená zobrazení uvnitř aplikace s vlastní lištou a návratem; na iOS od 16.4 in-app prohlížeč s „Hotovo“. Protože SPA by se po návratu načetla odshora, pozice ve feedu a otevřená záložka se ukládají do `sessionStorage` a obnovují až po dokončeném bootstrapu; návrat obsloužený bfcache si uložený záznam zahodí, aby pozici neposunul podruhé.

Vestavěný prohlížeč cizí stránky uvnitř našeho rozhraní zůstává mimo dosah: ověřeno 6. 9., že ČT24 posílá `X-Frame-Options: DENY` s `frame-ancestors 'self'` a iROZHLAS i Root.cz `SAMEORIGIN`. Facebook to obchází nativním WebView, který tyto hlavičky ignoruje; web takovou možnost nemá a obcházení se nezkouší. Skutečné čtení uvnitř Siftery má dvě reálné cesty — ingest plného textu (`access: full`), nebo nativní aplikace s WebView. Ani jedna není v tomto kroku rozhodnutá.

## ADR-013 Rychlý online prototyp a vstupní pluginy

6. 9. uživatel upřednostnil první internetový/mobilní prototyp před dokonalým dokončením milníků a výslovně požaduje oddělené vstupy, AI job a UI. Vstupy proto implementují ConnectorRegistry a normalizují do existujícího ingestu; ruční URL/text je rovnocenný RSS. Hosted prototyp přidává D1/R2 a Sites identity adaptéry, aby nevyžadoval nový placený cloudový projekt. Core ani existující Firebase implementace se nezahazují. UI je přenositelné na statický hosting, včetně uživatelem zmíněného GitHub Pages, ale potřebuje externí API. První job je explicitní export/import pro vlastní AI klient, nikoli předstíraná automatická AI.

Prototypový D1 adaptér ukládá jednotlivé doménové záznamy do owner-scoped SQL rows a používá optimistic epoch + atomický batch pro transakce. Omezený DraftData je jeden dokument s limitem800kB; není to neomezený blob celého účtu. Tento kompromis nemění core port ani Firestore mapování. Sources jsou v samostatné tabulce. Produkční maxima a benchmarky nebyly ověřeny.

## ADR-001 Produkt a samostatné účty

Osobní editor vlastních zdrojů s multimediálním feedem. Žádný parent/child vztah ani Audience entity. Škola = source group a režim all. Alternativa rodinné hierarchie byla výslovně odmítnuta uživatelem. Nezaměnit samostatnost účtu se slibem dětské moderace.

## ADR-002 Vite React a modulární TypeScript monolit

PWA je přihlášená osobní aplikace, nepotřebuje veřejné SEO/SSR. Vite snižuje počet runtime vrstev. Fastify obsluhuje REST/MCP přes sdílené core services. Next.js/Lion Reader fork by přinesl další rozhodnutí a závislosti, aniž by nahradil specifický redakční workflow.

## ADR-003 Firebase/Firestore Standard pro hosted MVP

Zachovat uživatelovu preferenci Google login,Hosting,Firestore,Cloud Run. Izolovat provider SDK do server wiring/storage a nevyužívat client Firestore reads. SQL je dobrá budoucí alternativa, ale nevytvářet současně druhý production persistence stack. Memory adapter pouze pro testování. Úložiště textu oddělit od Firestore metadata a feed entries.

## ADR-004 Search je deklarovaně omezený klientský index

MiniSearch nad≤3000 metadata položkami posledních90d a≤1000 saved. Výslovně zobrazit coverage/truncated. Historická vydání jsou samostatně procházetelná. Neomezený archive FTS není součástí MVP.

Aktuální dokumentace uvádí nativní text search pro **Firestore Enterprise**; tvrzení „Firestore nemá fulltext“ by bylo nepřesné. Pro Standard MVP nepotřebujeme měnit edici ani přidávat search server. Později SearchProvider může použít Enterprise search,PostgreSQL FTS,Meilisearch či Typesense. [Oficiální dokumentace](https://firebase.google.com/docs/firestore/enterprise/text-search), ověřeno2026-09-06.

## ADR-005 Externí AI subscription a lokální cron

Backend poskytuje kontrakt, nevolá primárně LLM API. První integrace osobní CLI+cron; volitelný API adapter není v MVP nutný. Codex dokumentuje noninteractive exec a subscription sign-in. Lokální prostředí a podporované flags ověřit před nastavením. Uživatelův OpenAI login nikdy nekopírovat do projektu nebo veřejného CI. [Exec](https://learn.chatgpt.com/docs/non-interactive-mode), [auth](https://learn.chatgpt.com/docs/auth), ověřeno2026-09-06.

## ADR-006 MCP je adaptér

Streamable HTTP na stejném backendu, explicitní agent token a scopes. Stdio proxy používá stejný remote auth. Plný OAuth odložen; raw bearer není příslib kompatibility s každým hosted klientem. Žádné business rules duplicitně v tool handleru. [MCP server guide](https://modelcontextprotocol.io/docs/develop/build-server), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## ADR-007 Ingest scheduling a scale-to-zero

Krátký synchronní tick přes Cloud Scheduler OIDC nebo lokální CLI/cron, source leases a nextFetchAt v DB. Žádný setInterval loop potřebný pro fungování na Cloud Run, žádný background promise po response. Cloud Tasks/queue přidat až když45s bounded tick nedostačuje. [Cloud Run scheduling](https://docs.cloud.google.com/run/docs/triggering/using-scheduler).

## ADR-008 RSSHub je volitelný vstup

RSS/Atom preferovat přímo. RSSHub URL je RSS source s externím poskytovatelem; backend na něm není závislý, neprovozuje RSSHub jako povinnou službu. Availability a privacy specifického RSSHub hostu zůstává vlastností source config.

## ADR-009 Rychlá redakce a stručná evidence

relevance/quality/novelty/basis, nikoli truth scoring. Zdroj a krátká přesná evidence pro distilled kartu brání vymyšlené pointě, ale nejsou fact-check. long_read potřebuje dostupný přečtený text. Metadata-only audio/video jasně označit. Sloučení stejné zprávy probíhá v AI výběru nad candidate refs, ne embeddingovým clusterem.

## ADR-010 Immutable vydání a mutable čtenářský stav

FeedRun a EditorialItem po publikování neměnit. Read/save/hide patří Candidate napříč historií. Podmíněná transakce s generation/revision/preferences version zamezí stale publish. Nový run během scrollu zobrazí banner, neprovede skryté přeuspořádání.

## ADR-011 Převzetí kódu

Newscope a Lion Reader MIT: cíleně zhodnotit konkrétní moduly a testy, přizpůsobit našim ports, zachovat licenci. Žádný automatický fork celého produktu. Dibao BUSL jen funkční inspirace, ne zdroj kopírovaného kódu. feeeed/Particle/Surf UI a produktové reference, žádné kopírování assetů.

## ADR-012 Bezpečné selhání a omezený offline rozsah

Poslední feed zůstává při selhání AI; škola se publikuje deterministicky. Offline shell+last feed+stavová fronta; video,celý archiv a všechny originální články nejsou offline slib. Conflict server versions vyvolá viditelný konflikt, nikoli tiché přepsání novějšího stavu.
