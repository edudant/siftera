# UX a frontend

## Vzhled a navigace

Mobile-first, šířka hlavního sloupce max.680px. Vizuální jazyk je obrazový feed sociální sítě (ADR-014), nikoli seznam odkazů ani noviny: souvislý scroll, karty bez rámečků oddělené jen mezerou a vlasovou linkou, hustota taková, aby se na obrazovku vešly aspoň dvě položky. Sociální mechanika se nepřebírá — žádné komentáře, veřejné lajky, sdílení, profily ani počty. Barevný režim se řídí systémem (`prefers-color-scheme`) v obou směrech; světlá i tmavá varianta musí držet kontrast AA.

**Typografie je bezpatková, včetně nadpisů.** Patkové písmo čte jako novinový titulek a je to nejsilnější jednotlivý signál čtečky; serif zůstává jen tam, kde nese hlas — u `distilled_fact`. Nadpis je tučný text, ne titulek.

**Zdroj má tvář.** Každá položka nese kruhový avatar zdroje: favicona z domény (`/favicon.ico`, lazy, `no-referrer`), a když chybí, monogram s barvou odvozenou od názvu — ověřeno, že ČT24 faviconu nemá, zatímco pět dalších českých zdrojů ano. Avatar je to, čím se zdroj čte jako někdo, kdo mluví, ne jako řádek metadat. Čas je ve feedu relativní („teď“, „6 h“, „včera“), absolutní datum až u starších položek.

**Spodní lišta neexistuje.** Veškerá navigace je v horní hlavičce, která má dva řádky: identita a akce (hledat, přidat, nastavení), pod nimi řada **kanálů jako ikon** (Přehled, uživatelské kategorie, Uložené) a pod ní tenká lišta s režimem **Feed · Vše** a ikonou řazení a filtrů (ADR-021). Uložené je kanál feedu, ne samostatná obrazovka. Hlavička je přilepená, ale při rolování dolů uhne a při prvním pohybu zpět nahoru se hned vrátí — ovládání je po ruce, aniž by trvale ukusovalo výšku, a obsah získá celou spodní část displeje.

Ikony se kreslí jako SVG, nepíšou jako znaky: textové glyfy mají na každé platformě jinou šířku i optickou váhu. Sada má jednu tloušťku tahu a velikost dědí z rodiče; cílová plocha ovládacích prvků je nejméně44×44px. Značka je stylizované síto — tři klesající pruhy, poslední v akcentní barvě — a stejný tvar nese i ikona aplikace.

Hledání není každodenní akce, takže v liště sedí jako lupa; teprve tap ji rozvine v pole přes celý řádek a zavře se křížkem. Feed nemá hlavičku vydání — proud začíná obsahem a poznámka nad ním říká, kolik je nepřečteného.

Obraz je jedna z možností, ne povinnost. Načítá se přímo z domény zdroje s `loading="lazy"`, `decoding="async"` a `referrerpolicy="no-referrer"`; obrázky se neproxují ani nehostují. Zdroj bez obrázků je normální stav — položka pak dostane textovou kartu, nikoli vymyšlenou barevnou výplň, protože zástupný gradient jen předstírá obsah, který nemáme.

Feed je jeden a přepínají se v něm kanály a režimy (ADR-016, ADR-021). Kanál říká *co* čtu: **Přehled** je vše, kategorie z preferencí jsou oblasti (News, Tech, Podcasty, Video, Věda), **Uložené** uzavírají řadu. Režim říká *jak*: **Feed** je redakční proud nepřečteného, **Vše** ukáže i přečtené a položky, které redakcí neprošly, takže Inbox jako samostatná obrazovka zanikl. Kanál i režim jsou v hlavičce, protože se přepínají často; řazení (podle výběru / od nejnovějších) a filtr na jednotlivý zdroj aktivního kanálu jsou v panelu za ikonou, aby nezabíraly výšku. Řada kanálů se roluje, takže další — do budoucna i pracovní přehledy — nic nerozbijí.

**Kategorie definuje uživatel, ne editor.** Kategorie je pojmenovaný filtr nad tématy a zdroji, který si člověk složí v Nastavení; témata od editora jsou pro filtrování příliš roztříštěná (měřeno: 55 témat na 40 položek). Kategorie žijí v preferencích, takže je editor v jobu vidí jako informaci o tom, co uživatele zajímá.

Feed není vydání, ale **proud nepřečteného** (ADR-015): publikované položky napříč vydáními, které uživatel nepřečetl ani neskryl a nejsou starší než14 dní, seřazené relevancí s útlumem podle stáří. Režim Vše je zároveň archiv: najde se v něm i přečtené a to, co z proudu vypadlo stářím. Čtení má dva stupně: **viděno** nastaví klient, když karta byla aspoň z poloviny ve viewportu déle než vteřinu — položka pak jen klesne v pořadí, nikdy nezmizí; **přečteno** zůstává explicitní, tedy otevření originálu nebo rozbalení. Prázdný proud znamená hotovo a musí to říct lidsky s odkazem na Uložené nebo Inbox, ne vypadat jako porucha.

Dřívější chování zobrazovalo poslední publikovaný run v redakčním pořadí. Škola chip vede do knihovny s group=school. Knihovna má chronologii/relevanci, zdroj/téma/typ/datum/read/saved filtry; saved je také rychlý samostatný vstup. Audience browsing je odstraněn.

Vizuální jazyk platí pro celou aplikaci, ne jen pro Dnes. Knihovna, Uložené i čekající položky v Inboxu používají stejnou kartu; liší se hustotou a doprovodným textem, nikoli tvarem.

## Karty

Všechny renderery dostávají `FeedItem`. Společné prvky: avatar a název zdroje, relativní čas, headline, uložit a „···“ v hlavičce, rozbalitelné shrnutí a tap na originál.

Feed není jedna karta opakovaná dokola. Důraz určuje `emphasis` od AI editora; chybí-li, odvodí se z prezentace a hodnocení. Zdroj ho může omezit přes `imageMode`. Rozhoduje i skutečný obraz: položka bez obrázku je textová karta a obraz užší než 480px překlopí celou kartu do kompaktního řádku s náhledem vedle textu — feedy `width` skoro nikdy neuvádějí, takže se měří po načtení.

| Důraz | Podoba |
|---|---|
| lead | obraz3:2 přes celou šířku, největší nadpis; nosná položka vydání |
| standard | obraz16:9 přes celou šířku, nadpis nad obrazem |
| compact | náhled96×96 vedle textu, menší nadpis |
| text | bez obrazu, nadpis a delší text nesou pozornost sám |

Shrnutí je ve výchozím stavu zkrácené na tři řádky; pod ním stojí tichý odkaz „Zobrazit víc“, a to jen když text skutečně přetéká. Tagy jsou vidět rovnou, protože nejrychleji řeknou, o čem položka je.

| Presentation | Obsah a hlavní akce |
|---|---|
| article | důraz podle `emphasis` a podle toho, jaký obraz reálně je |
| long_read | větší nadpis, delší perex, odhad času, viditelné „Stojí za přečtení“ |
| distilled_fact | velký krátký text patkovým písmem, dole malý dohledatelný zdroj; žádné „klikni pro pointu“ |
| school_notice | datum oznámení, text, případné rozlišené úkol/test/učivo, jasně odlišit tip AI |
| video | poster s poměrem stran, play na klik, titulek a provider; načíst YouTube iframe až po akci |
| audio | čtvercový cover, pořad/epizoda, délka pokud známá, otevřít Spotify/originál |
| budoucí typ | bezpečná textová/link karta s fallback label; necrashovat |

Media a platforma jsou samostatné od prezentace a témat. YouTube external ID validovat, nikdy nevkládat raw iframe HTML z ingestu/AI. Jedno přehrávané video současně, žádný autoplay při scrollování, nevytvářet player pro všechny položky předem.

## Otevření položky, čtení a feedback

Ovládání je v hlavičce karty vedle zdroje: **uložit** jako viditelná ikona, všechno ostatní pod „···“ (skrýt, vrátit na nepřečtené, podrobnosti). Spodní pruh akcí neexistuje — karta tím zkrátí o celý řádek a hlavička drží tvar u všech variant včetně těch bez obrazu.

**Přečteno se řídí samo.** Nastaví ho otevření originálu i rozbalení položky ve feedu; obojí je čtení. Ruční přepínač zůstává jen v „···“ jako oprava, ne jako každodenní akce, a pouhé projetí karty scrollováním read nenastavuje. Ztlumení patří jen položkám, které už byly přečtené při načtení feedu. Co uživatel přečte teď, zůstává plně čitelné — jinak si rozbalením textu sám ztlumí to, co chtěl přečíst; místo ztlumení dostane karta tichou značku „přečteno“ u zdroje. Přečtená karta nezmizí a nepřeskládá okolí; filtr se znovu uplatní až při přepnutí pohledu nebo novém načtení. Klient si proto drží pořadí feedu a položku, která ze serverového proudu vypadla, vrací na její místo — jinak by čtenář po každém přečtení ztratil kontext, kde ve feedu je.

**Video hraje v kartě.** U YouTube položky je místo statického náhledu fasáda s tlačítkem přehrát; kliknutí vloží přehrávač přímo do karty, takže se nikam neodchází a nemusí se obnovovat pozice. Do kliknutí nejde na přehrávač žádný request. Hraje vždy jen jedno video — spuštěním dalšího se předchozí zavře. Spuštění je čtení, stejně jako rozbalení textu.

**Tap na kartu otevře originál**, ve stejné kartě. Klikatelná je celá plocha kromě textu shrnutí, rozbalených podrobností a ovládacích prvků. Aby se do odchodu netrefil scroll, tap se počítá jen jako čisté tapnutí: posun prstu nad10px nebo držení nad500ms se bere jako rolování, ne jako volba. Nadpis je zároveň skutečný odkaz, takže cíl je dostupný i klávesnicí a čtečkou obrazovky — žádná akce není dostupná jen gestem.

**Text rozbaluje na místě.** Shrnutí je zkrácené na tři řádky a pod ním je odkaz „Zobrazit víc“; klik na text i na ten odkaz jen pokračuje v textu, jako to dělá Facebook — nic dalšího neodhaluje a zpět se dá odkazem „Zobrazit méně“. Odkaz nesmí být uvnitř zkráceného odstavce, protože clamp ho odstřihne i s textem, a ukazuje se jen při skutečném přetečení. „Proč to vidíte“ a podklad, na kterém shrnutí stojí, jsou v nabídce pod „···“ (ADR-021). Rozbalení nikam nenaviguje a neztrácí pozici — je to náhrada za zrušený detail. Stavová akce nesmí shodit feed do skeletonu: data se po ní načtou tiše, jinak by se rozbalení ztratilo a proud probliknul.

Vestavěný prohlížeč cizí stránky uvnitř rozhraní není dosažitelný a nebude se předstírat; zpravodajské weby vkládání do rámu zakazují. Až bude k dispozici `access: full`, položka se otevře do vlastního čtení s uloženým plain textem bezpečně formátovaným bez zdrojového HTML.

Skryté položky musí jít znovu zobrazit a vrátit mezi čekající — jednosměrné skrytí bez cesty zpět není přijatelné. Akce jsou stavové přepínače vlastního prostoru, ne signály pro ostatní.

Menu později doplní „Více podobného“, „Jsem rád, že jsem to viděl“, „Méně podobného“ a „Dobrý objev“. More/less dovoluje volitelně upřesnit položku/téma/zdroj v druhém kroku, ale výchozí akce bez povinného dialogu target=item. Volný komentář≤500 znaků zůstává soukromou poznámkou pro vlastní AI editor; nikde se nezveřejňuje.

Provenance: zdroj a datum jsou v hlavičce karty, „AI shrnutí“ a basis „celý dostupný text / výňatek / pouze metadata“ v nabídce pod „···“. Hodnoticí čísla zůstávají skrytá; nevytvářet vizuální dojem ověřené pravdy.

## Vydání a historie

Po poslední položce „To je dnešní výběr“ + „Označit vydání jako přečtené“ + „Pokračovat do historie“. Historická vydání se stránkují plynule, každý má datum. Nové vydání během čtení pouze zobrazí banner „Je připraven nový výběr“, nahradí seznam až po tapu. Empty run má lidskou zprávu a odkazy Knihovna/Škola, nikoli nekonečný skeleton.

Relevance sort v Knihovně řadí podle posledního uloženého relevance skóre, není novým LLM voláním. Historický run zachovává originální rank, změny read/save jsou aktuální napříč historií.

## Search

Search otevře full-screen input, keyboard focus a chips filtrů. Index MiniSearch v workeru pro ≥500 dokumentů; češtinu pro matching normalizovat lowercase a diakritiku, originální text neměnit. Search nad headline/summary/topics/source names, prefix matching s omezenou fuzzy tolerancí, explicitně uvést „Posledních90 dní a uložené“ + případné truncated upozornění. Starší historii lze procházet po vydáních, nepředstírat její prohledání.

Po dokončení snapshotu ukládat index/documents do user-scoped IndexedDB. Search nesmí čekat na další AI běh. Při prvním stahování postupový stav, při offline použít poslední index s datem aktualizace.

## Preferences a zdroje

Nastavení: Zdroje / Co chci číst / AI editor / Vzhled. Textové preference nahoře, strukturované ovládání až pod nimi. Žádný wizard o desítkách kroků. Přidání zdroje: vložit URL → discovery návrh → název/skupina a režim curated/all → uložit. Školní preset vyplní group=school a all, lze zobrazit původní URL. U problému viditelný status „načítání selhalo“, „jen perex“, datum posledního úspěchu.

AI editor obrazovka ukazuje credential label/expiry a poslední úspěšný run. Nový token lze zkopírovat jednou, po zavření už ne; revoke/rotate jasně popsat. Config ukázky nesmí se serverem sdílet AI přihlašovací údaje.

## Offline a výkon

- Service worker precache app shell; poslední vydání a jeho editorial metadata v IndexedDB, max.50 karet. Obrázky posledního vydání best-effort cache max.30MiB/60 obrázků, bez záruky cross-origin dostupnosti. Video/audio offline jen metadata a disabled play s vysvětlením.
- App shell network-independent, API nikdy do globálního service-worker cache. User-scoped data partition UID; při logout smazat query cache, IndexedDB partition a privátní image cache, odpojit pending queue. Přepnutí účtu nesmí zobrazit ani na snímek předchozí feed.
- Offline read/save/hide queue max.200 operací, TTL7d. Per candidate sloučit neodeslané změny polí; operationId stabilní při retry. Po připojení ověřit stejný UID, načíst verze a replay FIFO. Konflikt409 nechá serverový stav a ukáže možnost uživateli akci zopakovat; nesmí tiše přepsat novější zařízení. More/good/less/discovery eventy mají jedinečné ID a stejný retry.
- Neprefetchovat celý archiv: další1 stránka při posledních5 položkách, detail next2. Obrázky lazy kromě první viditelné, vždy width/height nebo rezervovaný poměr. Skeleton kopíruje rozměry karet.
- Render dlouhé historie pomocí windowing po100 položkách, stabilní keys podle editorialItemId, zachovat anchor při změně výšky a návratu. Žádné recyklování přehrávajícího iframe na jinou položku.
- Cíle na středním Androidu s throttled4G: LCP≤2.5s, CLS≤0.05, INP≤200ms; optimistická akce<100ms. Initial JS gzip cíl≤250KiB bez lazy editor/video/search. Benchmark run se zdokumentovaným zařízením; nejde o tvrzení měřeného výkonu.
- Touch target≥44×44px, keyboard focus, aria labels, reduced motion, screen-reader oznámení feedbacku a chyb. Žádná akce dostupná jen gestem.
