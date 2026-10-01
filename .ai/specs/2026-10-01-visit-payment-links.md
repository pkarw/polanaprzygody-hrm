# Linki płatności za wizytę

**Date**: 2026-10-01
**Status**: Draft — gotowa do implementacji po przeglądzie
**Spec ID**: VPAY

## 📝 TLDR

Dla każdej usługi z cennika Polany Przygody (`polana_bootstrap`/`catalog`) powstaje w bazie — i jest importowany przy instalacji aplikacji — **szablon linku płatności** (`checkout:checkout_link_template`, mechanizm już zaimplementowany w zainstalowanym module `@open-mercato/checkout`), ostylowany jak `https://polanaprzygody.pl/` (logo, kolory marki) przez pola brandingowe tego szablonu — strona płatności (`frontend/pay/[slug]`) jest w pełni "theming-driven" i nie wymaga forka. W momencie, gdy rejestracja **potwierdza wizytę** (istniejąca komenda `patient.visits.confirm`), ten sam przebieg żądania tworzy z właściwego szablonu unikalny `CheckoutLink` (komenda `checkout.link.create`) obejmujący usługę/usługi przypisane do wizyty (`PatientVisitService`), zapisuje referencję do tego linku **w custom fields wizyty** (`patient:patient_visit`), i zwraca gotowy URL w odpowiedzi API, żeby operator mógł go od razu skopiować — z opcją automatycznego wysłania mailem, jeśli operator tak zaznaczy. Gdy pacjent opłaci link, zdarzenie `checkout.transaction.completed` jest wychwytywane przez nowy subskrybent modułu `patient`, który odnajduje wizytę po zapisanej referencji i oznacza ją jako opłaconą (`payment_received_at`), zamykając pętlę rozliczeniową.

## 📝 Problem Statement

Rejestracja Polany Przygody potwierdza wizyty pacjentów w panelu `/backend` (komenda `patient.visits.confirm`, `.ai/specs/2026-09-29-patient-visits.md`), ale nie ma dziś żadnego mechanizmu łączącego potwierdzoną wizytę z płatnością. Moduł `patient` explicite nie zawiera pola `paid`/`paymentId`/`amount` na wizycie (`.ai/specs/2026-09-29-patient-visits.md`, linia 230) — "rozliczenie" (`isSettled`) to świadomie niezależna, ręczna flaga operacyjna, a nie zapis faktycznej płatności. Jednocześnie zainstalowany moduł `@open-mercato/checkout` ma już kompletny, gotowy do użycia mechanizm "szablon linku płatności → unikalny publiczny link → transakcja → status gatewaya" (`CheckoutLinkTemplate`/`CheckoutLink`/`CheckoutTransaction`/`GatewayTransaction`), z publiczną, niewymagającą logowania stroną płatności, której wygląd steruje się wyłącznie przez pola rekordu — nikt dotąd nie podłączył tego mechanizmu do domeny wizyt pacjenta. Efekt: rejestracja opłaca wizyty poza systemem i nie ma jak automatycznie powiązać wpłaty z konkretną wizytą ani zaproponować pacjentowi gotowego, markowego linku do samodzielnej zapłaty online.

Źródło: brief użytkownika 2026-10-01 (PL); referencje wizualne `https://polanaprzygody.pl/` (kolory, logo); zainstalowany kod `@open-mercato/checkout` (`CheckoutLinkTemplate`, `CheckoutLink`, `CheckoutTransaction`, `frontend/pay/[slug]`), `@open-mercato/core` `payment_gateways` (`GatewayTransaction`, `gateway_stripe`); istniejące specyfikacje [PAT](2026-09-29-patient-ehr-base.md), [VIS](2026-09-29-patient-visits.md) i ich zaimplementowany kod w `src/modules/patient/`; cennik `src/modules/polana_bootstrap/catalog-fixtures.ts`; powiązana, niezależna specyfikacja [PBOOK](2026-10-01-public-visit-booking-website.md) (publiczna rezerwacja — jawnie wyklucza płatności online ze swojego zakresu).

## Resolved decisions (brama Open Questions zamknięta)

Szkic tej specyfikacji przechodził przez bramę Open Questions. Użytkownik potwierdził kierunek "custom fields wszędzie, gdzie potrzebna jest referencja" (zarówno wizyta→link, jak i szablon→usługa) i poprosił o kontynuację — poniższe decyzje domykają pozostałe pytania architektoniczne z rekomendacją najbardziej odwracalnego, najmniej inwazyjnego wariantu. Każda jest oznaczona do ewentualnej korekty.

| # | Pytanie | Decyzja | Uzasadnienie |
|---|---|---|---|
| Q1 | Gdzie żyje referencja wizyta→link? | **Custom fields na `patient:patient_visit`** (`payment_link_id`, `payment_link_slug`, `payment_link_status`, `payment_received_at`) — pierwsze custom fields tej encji | Potwierdzone wprost przez użytkownika; dodatkowo custom fields nie wymagają migracji schematu przy iteracji na kształcie pól |
| Q2 | Granulacja szablonów przy wizycie z wieloma usługami | **Jeden `CheckoutLinkTemplate` per usługa** (literalnie odpowiada brzmieniu briefu: "szablony... które będą odpowiadały usługom z cennika"), zidentyfikowany przez custom field `catalog_product_id` na szablonie. Dla wizyty z **jedną** usługą (zdecydowana większość) link powstaje wprost z jej szablonu. Dla wizyty z **wieloma** usługami używany jest jeden dodatkowy, współdzielony szablon brandingowy ("Polana — wizyta wieloskładnikowa", bez `catalog_product_id`), a lista pozycji (`priceListItems`, `pricingMode: 'price_list'`) jest budowana dynamicznie z usług tej konkretnej wizyty w momencie tworzenia linku | Spełnia dosłowne żądanie (szablon per usługa) bez wymyślania kombinatoryki szablonów na każdy możliwy zestaw usług |
| Q3 | Co z linkiem przy `unconfirm`/reschedule, które czyszczą `confirmedAt`? | Jeśli `payment_received_at` jest ustawione (zapłacone) → `unconfirm` jest **blokowane** (409, komunikat "nie można cofnąć potwierdzenia opłaconej wizyty"). Jeśli link istnieje, ale nieopłacony → `unconfirm` ustawia istniejący `CheckoutLink.status = 'inactive'` (strona płatności pokazuje "link nieaktywny"); ponowne potwierdzenie generuje nowy link. Reschedule (zmiana terminu), który tylko ubocznie czyści `confirmedAt`, **nie** dezaktywuje linku — zmiana godziny wizyty nie unieważnia już opłaconej/wysłanej płatności za usługę | Chroni integralność rozliczeniową (nie da się "odpotwierdzić" opłaconej wizyty), a jednocześnie nie karze zwykłej zmiany terminu |
| Q4 | Gdzie mieszka logika tworząca link? | **Rozszerzenie modułu `patient`**, ale jako **bezpośrednie, synchroniczne wywołanie w ramach komendy `patient.visits.confirm`** (nowy wewnętrzny krok `ensurePaymentLinkForVisit`, post-commit względem zapisu potwierdzenia), a NIE jako asynchroniczny subskrybent na `patient.visit.confirmed` | Wymaganie "operator od razu widzi link do skopiowania" wymaga, by link istniał w odpowiedzi HTTP tego samego żądania — fire-and-forget subskrybent eventu nie mógłby tego zagwarantować. Event `patient.visit.confirmed` jest nadal emitowany bez zmian, dla innych, faktycznie odłączonych konsumentów |
| Q5 | Automatyczny e-mail: razem z potwierdzeniem czy osobny krok? | **Oba**: pole `sendPaymentLinkEmail?: boolean` w body `POST .../confirmation` (ścieżka główna, jedna akcja operatora) ORAZ niezależny endpoint `POST /api/patient/visits/[id]/payment-link/email` do ręcznego (re)wysłania w dowolnym momencie później | Brief mówi "wyświetlić do skopiowania LUB wysłać mailem" — to wybór operatora w danej chwili, nie tylko w momencie potwierdzenia; potrzebny też "resend", gdy pierwsza wysyłka się nie powiedzie |
| Q6 | Relacja do PBOOK | **W pełni niezależna** — VPAY nie odwołuje się do kodu PBOOK; jedyny punkt styku to fakt, że obie specyfikacje operują na `patient:patient_visit` i `patient.visits.confirm`, więc PBOOK (gdy powstanie) będzie automatycznie korzystać z tego samego mechanizmu linku płatności bez dodatkowej pracy | Najmniejszy blast radius; unika projektowania pod niezatwierdzoną jeszcze specyfikację |

Domyślne, odwracalne decyzje: provider płatności = `gateway_stripe` (jedyny zainstalowany); waluta `PLN`; strony sukcesu/anulowania płatności używają domyślnych tekstów `checkout` z podmienionym brandingiem, bez dedykowanej treści medycznej; link nie wygasa automatycznie (`expiresAt = null`) w iteracji 1; limit wykorzystania linku (`maxCompletions`) = 1 (jedna wizyta = jedna płatność, ponowna próba po `failed`/`cancelled` używa tego samego linku, nie generuje nowego).

## 📝 Proposed Solution

1. **Szablony linków płatności per usługa, importowane przy instalacji — zamiast przykładowych szablonów `checkout`.** Zainstalowany moduł `checkout` sam seeduje przy starcie trzy generyczne przykładowe szablony (`seed/examples.ts` → `seedCheckoutExamples`, wywoływane z hooka `setup.seedExamples`: "Consulting Fee", "Donation", "Event Ticket") — nie są one częścią tożsamości Polany i nie powinny trafiać do produkcyjnej instalacji. `src/modules/polana_bootstrap/setup.ts` już dziś stosuje dokładnie ten wzorzec zastępowania danych przykładowych instalowanych modułów: jego własny hook `seedExamples` uruchamia się **po** hookach `seedExamples` modułów zarejestrowanych wcześniej w `src/modules.ts` (potwierdzone: `checkout` jest zarejestrowany przed `polana_bootstrap`), i np. `seedPolanaResources` jawnie komentuje "Runs after the core `resources` seed, so its example set is already in the database and can be replaced with the real gabinets in one pass". Nowa funkcja `seedPolanaPaymentLinkTemplates` dołączana analogicznie do istniejącego wywołania w `polana_bootstrap/setup.ts`:
   - usuwa (miękko, `deletedAt`) lub dezaktywuje (`status: 'inactive'`) trzy przykładowe `CheckoutLinkTemplate` z `seedCheckoutExamples` (dopasowane po `name` — "Consulting Fee"/"Donation"/"Event Ticket" — tak jak `ensureTemplate` w `seed/examples.ts` sam dopasowuje po `name` w ramach `tenantId`/`organizationId`);
   - tworzy po jednym `CheckoutLinkTemplate` dla każdej pozycji `POLANA_CATALOG_FIXTURES`, idempotentnie i self-cleaning (ten sam styl co `catalog-bootstrap.ts`), z:
   - brandingiem Polany (`logoUrl`, `primaryColor`, `secondaryColor`, `backgroundColor`, `themeMode: 'light'`) odwzorowanym z `https://polanaprzygody.pl/`;
   - `pricingMode: 'fixed'`, kwotą = aktualna cena usługi z `catalog` (`catalogPricingService`), walutą `PLN`;
   - `gatewayProviderKey: 'stripe'`;
   - domyślnymi treściami e-maili (`startEmailSubject/Body` itd.) w tonie Polany;
   - custom fieldem `catalog_product_id` wskazującym usługę, której szablon dotyczy (nowy fieldset na encji `checkout:checkout_link_template`, analogiczny do istniejącego `CHECKOUT_LINK_CUSTOM_FIELDS`, dopisany przez `ensureCustomFieldDefinitions` z `source: 'polana_bootstrap'`).
   Dodatkowo tworzony jest jeden szablon współdzielony ("Polana — wizyta wieloskładnikowa", bez `catalog_product_id`, `pricingMode: 'price_list'` z pustą listą pozycji uzupełnianą dynamicznie) na wypadek wizyt z więcej niż jedną usługą.
2. **Tworzenie unikalnego linku przy potwierdzeniu wizyty.** Komenda `patient.visits.confirm` (`src/modules/patient/commands/visits.ts`) po swoim własnym atomowym zapisie (confirmedAt/confirmedByUserId) wywołuje nowy wewnętrzny krok `ensurePaymentLinkForVisit(visit, services, { sendEmail })`:
   - jeśli wizyta ma już aktywny (nie `inactive`) `payment_link_id` w custom fields → zwraca istniejący link (idempotentność, brak duplikatów przy wielokrotnym potwierdzaniu/retry);
   - inaczej odczytuje usługi wizyty (`PatientVisitService`), odnajduje właściwy szablon (po `catalog_product_id` dla jednej usługi, albo szablon współdzielony + dynamiczne `priceListItems` dla wielu usług);
   - woła `commandBus.execute('checkout.link.create', { templateId, overrides? })`, co generuje unikalny `slug` i zwraca pełny publiczny URL;
   - zapisuje `payment_link_id`, `payment_link_slug`, `payment_link_status: 'pending'` w custom fields `patient:patient_visit` przez `dataEngine.setCustomFields(...)`.
   Błąd tworzenia linku (np. brak skonfigurowanego gatewaya) **nie** cofa ani nie blokuje samego potwierdzenia wizyty — confirm kończy się sukcesem, a odpowiedź zawiera `paymentLink: null, paymentLinkError: <kod błędu>`; operator może ponowić przez endpoint ręczny (patrz API Contracts).
3. **Prezentacja operatorowi.** Odpowiedź `POST /api/patient/visits/[id]/confirmation` rozszerzona o `paymentLink: { id, slug, url, status } | null` — UI rejestracji pokazuje przycisk "Kopiuj link" od razu po potwierdzeniu, bez dodatkowego zapytania.
4. **Opcjonalny automatyczny e-mail.** Gdy `sendPaymentLinkEmail: true` w żądaniu potwierdzenia (lub przy ręcznym wywołaniu `POST .../payment-link/email` później), moduł `patient` wysyła e-mail przez `sendEmail()` (ten sam transport co `checkout`, rozwiązywany automatycznie przez `channel_resend`/`channel_ses`) z nowym szablonem React-email (`VisitPaymentLinkEmail.tsx`, branding Polany) na adres opiekuna pacjenta (odczytany przez istniejącą, autoryzowaną ścieżkę `patient`→`customers`, analogicznie do `PatientContactLink` używanego w PBOOK). Wysyłka jest fire-and-forget z logowaniem błędu — nieudana wysyłka nie cofa potwierdzenia ani nie usuwa linku.
5. **Rozliczenie po opłaceniu.** Nowy, pierwszy subskrybent modułu `patient` (`subscribers/payment-link-completed.ts`) nasłuchuje `checkout.transaction.completed` (payload: `{transactionId, linkId, templateId, slug, status, paymentStatus, amount, currency, gatewayProvider, gatewayTransactionId, occurredAt, tenantId, organizationId}`), odnajduje wizytę, której custom field `payment_link_id === payload.linkId` (w ramach `tenantId`/`organizationId` z payloadu), i zapisuje `payment_received_at = payload.occurredAt`, `payment_link_status: 'completed'` przez `dataEngine.setCustomFields`. To pole jest celowo niezależne od `isSettled` (tak jak `isSettled` jest dziś niezależne od `status`/`confirmedAt`) — rejestracja nadal ręcznie decyduje o formalnym rozliczeniu, ale widzi wprost, że płatność internetowa wpłynęła.

## 📝 Architecture

```
Rejestracja (/backend)                    patient module                         checkout module (installed)        payment_gateways (installed)
───────────────────────                   ──────────────────                      ─────────────────────────         ──────────────────────────
POST /visits/[id]/confirmation  ────────▶ patient.visits.confirm
  { confirmed: true,                         │
    sendPaymentLinkEmail? }                  ├─ zapis confirmedAt/By (atomic)
                                              ├─ ensurePaymentLinkForVisit()
                                              │     ├─ odczyt PatientVisitService[]
                                              │     ├─ wybór CheckoutLinkTemplate
                                              │     │   (po custom field catalog_product_id
                                              │     │    lub szablon wieloskładnikowy)
                                              │     ├─ commandBus.execute ───────────────▶ checkout.link.create
                                              │     │                                          │ generuje slug, CheckoutLink
                                              │     │◀─────────────────────────────────────────┘
                                              │     └─ setCustomFields(patient:patient_visit,
                                              │           payment_link_id/slug/status)
                                              ├─ (opcjonalnie) sendEmail(VisitPaymentLinkEmail)
                                              └─ emit patient.visit.confirmed (bez zmian)
  ◀──────── { confirmed:true, paymentLink }
                                                                                   Pacjent otwiera /pay/{slug} (no-auth,
                                                                                   branding z CheckoutLinkTemplate)
                                                                                          │ płaci
                                                                                          ▼
                                                                                   checkout.transaction.completed ───▶ GatewayTransaction
                                              patient:payment-link-completed  ◀─────────── (event, payload ma linkId/slug)
                                              (nowy subscriber, pierwszy w module)
                                                  ├─ znajdź wizytę po custom field payment_link_id
                                                  └─ setCustomFields(payment_received_at, status)
```

**Co się zmienia / co jest ponownie użyte:**
- Ponownie użyte bez modyfikacji: cały stos `checkout` (encje, komendy, strona `/pay/[slug]`, `PayPage.tsx`, kolejka e-mail, `payment_gateways`, `gateway_stripe`). Zero forków zainstalowanego kodu.
- Nowe, app-owned: krok bootstrapu szablonów w `polana_bootstrap`, custom fields na `checkout:checkout_link_template` i `patient:patient_visit`, rozszerzenie komendy `patient.visits.confirm` o `ensurePaymentLinkForVisit`, dwa nowe endpointy ręczne w `patient`, jeden nowy subskrybent w `patient`, jeden nowy szablon e-mail.
- Zgodność z `AGENTS.md`: cross-module wyłącznie przez `commandBus.execute('checkout.link.create', …)` (ID, nie ORM relacja) i przez event `checkout.transaction.completed` (typed event + subscriber) — nigdy bezpośredni import encji `checkout` do `patient` czy odwrotnie.

## 📝 Data Model

### Nowe custom fields na `checkout:checkout_link_template` (dopisane do istniejącego fieldsetu, `source: 'polana_bootstrap'`)

| Key | Typ | Opis |
|---|---|---|
| `catalog_product_id` | text (scalar ID) | `catalog:catalog_product.id`, którego ten szablon dotyczy. `null`/nieobecne dla szablonu współdzielonego "wizyta wieloskładnikowa" |
| `catalog_product_sku` | text (snapshot) | SKU usługi w momencie utworzenia szablonu — wyłącznie do czytelności w UI administracyjnym `checkout`, nigdy nie czytane programowo |

### Nowe custom fields na `patient:patient_visit` (pierwsze custom fields tej encji, `source: 'patient'`)

| Key | Typ | Opis |
|---|---|---|
| `payment_link_id` | text (scalar ID) | `checkout:checkout_link.id` aktywnego/ostatniego linku tej wizyty |
| `payment_link_slug` | text | cache `CheckoutLink.slug`, żeby zbudować URL bez dodatkowego odczytu |
| `payment_link_status` | text enum (`pending`/`processing`/`completed`/`failed`/`cancelled`/`expired`/`inactive`) | cache ostatniego znanego statusu, odświeżany przez subskrybenta z pkt 5 oraz przy `unconfirm` |
| `payment_received_at` | datetime, nullable | ustawiane wyłącznie przez subskrybenta `checkout.transaction.completed`; niezależne od `isSettled` i od `status` wizyty |

Wszystkie cztery pola: `formEditable: false` (operator nigdy nie wpisuje ich ręcznie — wyłącznie system).

### Brak nowych tabel/encji

Zgodnie z Q2/Q1 cała funkcjonalność mieści się w istniejących encjach `checkout` (bez zmian) plus custom fields na dwóch istniejących encjach — nie wprowadzamy nowej tabeli łączącej. Relacja wizyta↔link jest zawsze 1:1 (jedna aktywna płatność na wizytę; wiele usług jednej wizyty trafia do jednego linku z wieloma pozycjami, nie do wielu linków).

### Migracje

Brak migracji schematu bazy — custom fields nie wymagają `yarn db:generate`; definicje są rejestrowane przez `ensureCustomFieldDefinitions` przy starcie/instalacji (ten sam mechanizm co `polana_bootstrap`'s `PRODUCT_FIELDS` dziś).

## 📝 API Contracts

### Rozszerzenie istniejącego `POST /api/patient/visits/[id]/confirmation`

Request body (dodane pole, opcjonalne, domyślnie `false`):
```jsonc
{ "confirmed": true, "expectedUpdatedAt": "...", "sendPaymentLinkEmail": false }
```
Response (dodane pole):
```jsonc
{
  "confirmed": true,
  "updatedAt": "...",
  "paymentLink": { "id": "uuid", "slug": "abc123", "url": "https://.../pay/abc123", "status": "pending" } | null,
  "paymentLinkError": "gateway_not_configured" | "no_services_on_visit" | null
}
```
`unconfirm` (ten sam endpoint, `confirmed: false`) zwraca 409 z kodem `visit_already_paid`, jeśli `payment_received_at` jest ustawione.

### Nowy: `POST /api/patient/visits/[id]/payment-link` (regeneracja/ponowienie)

Tworzy link, jeśli nie istnieje lub istniejący jest `inactive`/`expired`; jeśli aktywny link już istnieje, zwraca go bez zmian (idempotentne). Wymaga, by wizyta była potwierdzona (`confirmedAt != null`) i miała co najmniej jedną usługę. ACL: `patient.visits.manage` (ten sam co confirm).

### Nowy: `POST /api/patient/visits/[id]/payment-link/email`

Wysyła (lub wysyła ponownie) e-mail z istniejącym linkiem płatności do opiekuna pacjenta. 404, jeśli wizyta nie ma jeszcze linku. ACL: `patient.visits.manage`.

### Zmiana w `patient.visits.confirm` (komenda)

Input rozszerzony o opcjonalne `sendPaymentLinkEmail?: boolean`. Zwracany rezultat rozszerzony o `paymentLink`/`paymentLinkError` jak wyżej. Event `patient.visit.confirmed` — payload **bez zmian** (nadal tylko `{id, patientId, tenantId, organizationId, updatedAt}`), zgodnie z zasadą modułu "no names, no free text" w payloadach eventów.

## 📝 UI/UX

- Panel potwierdzenia wizyty (formularz confirm w `/backend`) dostaje dodatkowy checkbox "Wyślij link do płatności mailem" obok istniejącego przycisku potwierdzenia.
- Po potwierdzeniu, w widoku szczegółu wizyty pojawia się sekcja "Płatność": status (badge z kolorem stanu — reużycie istniejących tokenów statusu, nie nowych kolorów ad hoc, per `AGENTS.md` "Never hard-code... status colors"), pole z URL + przycisk "Kopiuj", przycisk "Wyślij mailem" (woła nowy endpoint), przycisk "Wygeneruj ponownie" widoczny tylko gdy status to `inactive`/`expired`/`failed`.
- Stany: ładowanie (spinner na przycisku podczas tworzenia linku), błąd (czytelny komunikat zamiast surowego kodu błędu, zlokalizowany), brak usług na wizycie (przycisk "Wygeneruj link" wyłączony z tooltipem), konflikt 409 przy próbie `unconfirm` opłaconej wizyty (modal blokujący z wyjaśnieniem).
- Strona `/pay/[slug]` sama w sobie nie wymaga nowego UI — to istniejący, ostylowany przez branding szablonu komponent `checkout`'a; zadaniem tej specyfikacji jest wyłącznie dobór wartości brandingowych (kolory/logo Polany) na szablonach. Jako konkretny punkt startowy proponuje się paletę już ustaloną i reużywaną we wszystkich dotychczasowych makietach Polany w tym repo (PAT/VIS/VCAL/PBOOK): `primaryColor:'#2A5C47'`, hover/`secondaryColor:'#1E4435'`, akcent/tło karty `'#EFF1C5'`, `themeMode:'light'` — do potwierdzenia/dostrojenia względem faktycznego logo i kolorów na żywej stronie `polanaprzygody.pl` przy implementacji.

### Makiety (do przetworzenia przez agenta implementującego)

Źródło: `.ai/specs/assets/vpay-ui-mockups.html` (generator `.ai/specs/assets/render-vpay-mockups.mjs`, ten sam wzorzec co w specyfikacjach PAT/VIS/VCAL/PBOOK — `node .ai/specs/assets/render-vpay-mockups.mjs` renderuje poniższe PNG). W tym środowisku render nie mógł zostać wykonany (brak uprawnień root do doinstalowania zależności systemowych Playwrighta/Chromium w tym sandboksie) — HTML źródłowy jest gotowy i można go otworzyć bezpośrednio w przeglądarce albo dokończyć render w środowisku z odpowiednimi uprawnieniami; poniższe nazwy plików to docelowe ścieżki po uruchomieniu skryptu.

| # | Makieta | Zakres | Co pokazuje |
|---|---|---|---|
| M1 | [Link utworzony, jedna usługa](assets/vpay-ui-01-link-utworzony-jedna-usluga.png) | zakładka Płatność po potwierdzeniu | Baner sukcesu, karta linku (szablon/adres/data utworzenia), przyciski Kopiuj/Wyślij mailem/Wygeneruj ponownie, checkbox przy formularzu potwierdzenia |
| M2 | [Opłacona, blokada cofnięcia](assets/vpay-ui-02-oplacona-blokada-cofniecia.png) | zakładka Płatność, stan `completed` | Baner błędu `visit_already_paid`, przycisk "Cofnij potwierdzenie" wyłączony, dziennik płatności z wpisem `checkout.transaction.completed` |
| M3 | [Strona /pay/[slug], jedna usługa](assets/vpay-ui-03-pay-page-jedna-usluga.png) | publiczna strona płatności | Branding Polany (hero, logo, kolory), pojedyncza pozycja `fixed`, przycisk płatności, stopka zaufania |
| M4 | [Strona /pay/[slug], wiele usług + sukces](assets/vpay-ui-04-pay-page-wiele-uslug-i-sukces.png) | publiczna strona płatności | Rozbicie na pozycje `price_list` dla wizyty wieloskładnikowej oraz ekran po opłaceniu |
| M5 | [Stany brzegowe](assets/vpay-ui-05-stany-brzegowe.png) | zakładka Płatność | Sześć stanów z sekcji Edge Cases: brak usług, gateway niekonfigurowany, link nieaktywny, błąd maila, płatność nieudana, wizyta anulowana po opłaceniu |

## 📝 Edge Cases & Failure Scenarios

| Scenariusz | Zachowanie |
|---|---|
| Wizyta bez żadnej usługi (`PatientVisitService` puste) w momencie potwierdzenia | Confirm się udaje; `paymentLinkError: 'no_services_on_visit'`; operator może dodać usługę i użyć endpointu ręcznego |
| Brak skonfigurowanego/aktywnego gatewaya (`gateway_stripe` bez credentiali) | `checkout.link.create` zwraca błąd; confirm i tak się udaje, `paymentLinkError: 'gateway_not_configured'` |
| Wielokrotne potwierdzenie tej samej wizyty (retry sieciowy, podwójny klik) | `ensurePaymentLinkForVisit` jest idempotentne — wykrywa istniejący aktywny `payment_link_id` i zwraca go bez tworzenia duplikatu |
| `unconfirm` wizyty z nieopłaconym, ale istniejącym linkiem | Link przechodzi w `inactive` (strona pay pokazuje komunikat niedostępności); ponowne `confirm` tworzy nowy link (nowy `slug`) |
| `unconfirm` wizyty z `payment_received_at` ustawionym | Blokowane, 409 `visit_already_paid` — nie da się "odpotwierdzić" opłaconej wizyty bez wcześniejszej interwencji (np. zwrotu) poza zakresem tej specyfikacji |
| Reschedule wizyty (zmiana `startsAt`/zasobu), który ubocznie czyści `confirmedAt` | Link **pozostaje aktywny** — zmiana terminu nie unieważnia opłaty za usługę; `confirmedAt` i tak trzeba będzie ustawić ponownie przez osobne potwierdzenie, które wykryje istniejący aktywny link i go nie zdubluje |
| Pacjent płaci po tym, jak wizyta została anulowana (`status: cancelled`) | Poza blokadą — `checkout` nie wie nic o statusie wizyty. Subskrybent `payment-link-completed` i tak zapisuje `payment_received_at` (fakt wpłaty jest prawdziwy niezależnie od tego, czy usługa się odbędzie); rejestracja widzi to w UI i obsługuje zwrot ręcznie — wyraźnie poza zakresem (patrz Non-goals) |
| Dwie usługi tej samej wizyty mają różne stawki VAT/promocje | Pozycje `priceListItems` szablonu wieloskładnikowego budowane są z aktualnych, już wyliczonych cen (`catalogPricingService`, uwzględniających `isPromotion`) w momencie tworzenia linku — snapshot, nie przeliczenie live przy płatności |
| Webhook/`checkout.transaction.completed` dociera, ale żadna wizyta nie ma pasującego `payment_link_id` (np. link użyty poza tym mechanizmem) | Subskrybent loguje i kończy bez błędu (nie każdy `CheckoutLink` musi pochodzić z wizyty) |

## 📝 Risks & Impact Review

- **Blast radius**: zmiany ograniczone do modułu `patient` (nowe pola/komenda/endpointy/subskrybent) i `polana_bootstrap` (nowy krok bootstrapu + custom fields na encji `checkout`); zero zmian w zainstalowanych pakietach `checkout`/`payment_gateways`/`gateway_stripe`.
- **Ryzyko techniczne do zweryfikowania przed Fazą 2**: odnalezienie wizyty po wartości custom field (`payment_link_id === linkId`) w subskrybencie wymaga odwrotnego wyszukiwania po custom field — trzeba zweryfikować, czy istniejący mechanizm zapytań po custom fields (używany dziś głównie do filtrów `DataTable`/`CrudForm`) udostępnia też programowe API do zapytań serwisowych spoza kontekstu UI; jeśli nie, alternatywą jest zapisanie `visitId` jako custom field również po stronie `checkout:checkout_link` (symetryczna referencja zwrotna) zamiast wyszukiwania.
- **Zgodność/compatibility**: komenda `patient.visits.confirm` zyskuje nowe opcjonalne pole wejściowe i nowe pole w odpowiedzi — rozszerzenie addytywne, nie łamiące; event `patient.visit.confirmed` pozostaje bez zmian (frozen surface zachowana).
- **Dane wrażliwe**: e-mail z linkiem płatności zawiera URL do zewnętrznej (ale wewnątrz-appowej) strony płatności — żadnych danych medycznych w treści maila, zgodnie z tym, jak `events.ts` modułu patient traktuje payloady.
- **Rollback**: funkcja jest czysto addytywna — wyłączenie polega na niewywoływaniu `ensurePaymentLinkForVisit` (feature flag na poziomie modułu `patient`, do rozważenia w Fazie 1) bez utraty istniejącej funkcjonalności potwierdzania wizyt.

## 📋 Phasing

- **Faza 1 — Szablony i branding (bez integracji z wizytami).** Bootstrap `polana_bootstrap` tworzy `CheckoutLinkTemplate` per usługa + szablon wieloskładnikowy, z pełnym brandingiem Polany. Weryfikowalne samodzielnie: operator może ręcznie utworzyć `CheckoutLink` z dowolnego szablonu w panelu `checkout` i zobaczyć stronę `/pay/[slug]` wyglądającą jak polanaprzygody.pl — zero zmian w module `patient`.
- **Faza 2 — Tworzenie linku przy potwierdzeniu wizyty.** Custom fields na `patient:patient_visit`, rozszerzenie `patient.visits.confirm` o `ensurePaymentLinkForVisit`, rozszerzenie API/response. Weryfikowalne: potwierdzenie wizyty z jedną usługą zwraca działający link płatności.
- **Faza 3 — Wiele usług, e-mail, operacje ręczne.** Szablon wieloskładnikowy w akcji, checkbox "wyślij mailem", endpointy `payment-link`/`payment-link/email`.
- **Faza 4 — Rozliczenie zwrotne.** Subskrybent `checkout.transaction.completed`, blokada `unconfirm` opłaconej wizyty, cache statusu.

## 📋 Implementation Plan

### Faza 1 — Szablony i branding
1. Dodać custom fields `catalog_product_id`/`catalog_product_sku` na `checkout:checkout_link_template` (`ensureCustomFieldDefinitions`, `source: 'polana_bootstrap'`). Test: definicje istnieją po uruchomieniu bootstrapu, idempotentne przy ponownym uruchomieniu.
2. Zmapować branding na wartości `primaryColor`/`secondaryColor`/`backgroundColor`/`logoUrl`/`themeMode` — punkt startowy to paleta już ustalona w makietach Polany w tym repo (`#2A5C47`/`#1E4435`/`#EFF1C5`, patrz UI/UX i [M3](assets/vpay-ui-03-pay-page-jedna-usluga.png)/[M4](assets/vpay-ui-04-pay-page-wiele-uslug-i-sukces.png)), do zweryfikowania względem logo i kolorów na żywej stronie `polanaprzygody.pl`. Test: manualny przegląd strony `/pay/[slug]` dla jednego utworzonego ręcznie linku, porównanie z makietami M3/M4.
3. Napisać `seedPolanaPaymentLinkTemplates` w `src/modules/polana_bootstrap/` (np. `payment-link-bootstrap.ts`), wywoływaną z `polana_bootstrap/setup.ts`'s `seedExamples` **po** `seedPolanaCatalog`: (a) dezaktywuje/usuwa trzy przykładowe szablony `checkout` ("Consulting Fee"/"Donation"/"Event Ticket" z `seedCheckoutExamples`), (b) dla każdej pozycji `POLANA_CATALOG_FIXTURES` tworzy/aktualizuje `CheckoutLinkTemplate` (status `active`, `pricingMode: 'fixed'`, kwota z `catalog`) + ustawia `catalog_product_id`. Idempotentny i self-cleaning jak `catalog-bootstrap.ts`. Test: uruchomienie dwa razy z rzędu nie tworzy duplikatów i nie przywraca przykładowych szablonów; usunięcie usługi z fixtures usuwa/dezaktywuje jej szablon.
4. Utworzyć jeden szablon współdzielony "Polana — wizyta wieloskładnikowa" (`pricingMode: 'price_list'`, pusta lista startowa) w tym samym kroku. Test: w panelu `checkout` widoczne są wyłącznie szablony Polany (per usługa + wieloskładnikowy), bez "Consulting Fee"/"Donation"/"Event Ticket".

### Faza 2 — Integracja z potwierdzeniem wizyty
5. Dodać custom fields `payment_link_id/slug/status/payment_received_at` na `patient:patient_visit` (pierwszy `ensureCustomFieldDefinitions` w module `patient`, `source: 'patient'`). Test: definicje istnieją, `formEditable: false`.
6. Zaimplementować `ensurePaymentLinkForVisit(visit, services, scope, { sendEmail })` w `src/modules/patient/commands/` (lub `lib/`): ścieżka dla jednej usługi — znajdź szablon po `catalog_product_id`, wywołaj `checkout.link.create`. Test jednostkowy: wizyta z jedną usługą → link utworzony, custom fields zapisane.
7. Wpiąć wywołanie do `patient.visits.confirm` post-commit; rozszerzyć input (`sendPaymentLinkEmail`) i response (`paymentLink`/`paymentLinkError`). Test: confirm zwraca `paymentLink` w odpowiedzi API; błąd tworzenia linku nie cofa potwierdzenia (confirm nadal `200`).
8. Idempotentność: drugie potwierdzenie (lub retry) tej samej wizyty nie tworzy drugiego linku. Test: dwa kolejne wywołania `confirm` → ten sam `payment_link_id`.

### Faza 3 — Wiele usług, e-mail, operacje ręczne
9. Ścieżka wielu usług: zbudować `priceListItems` z `PatientVisitService` + aktualnych cen katalogu, użyć szablonu współdzielonego. Test: wizyta z dwiema usługami → link z dwiema pozycjami cennika o poprawnych kwotach.
10. Szablon e-mail `VisitPaymentLinkEmail.tsx` (branding Polany) + wysyłka przez `sendEmail()` gdy `sendPaymentLinkEmail: true`. Test: e-mail wysłany (w środowisku testowym — przechwycony transport) zawiera poprawny URL.
11. Endpoint `POST /api/patient/visits/[id]/payment-link` (tworzenie/regeneracja) + `POST .../payment-link/email` (ręczna wysyłka). Test: regeneracja po `inactive` tworzy nowy `slug`; wysyłka na żądanie działa bez ponownego potwierdzania wizyty.
12. UI: checkbox przy potwierdzeniu, sekcja "Płatność" w widoku wizyty (status, kopiuj, wyślij, wygeneruj ponownie) wg [M1](assets/vpay-ui-01-link-utworzony-jedna-usluga.png), stany ładowania/błędu/braku usług wg [M5](assets/vpay-ui-05-stany-brzegowe.png). Test: manualny przegląd w przeglądarce (golden path + brak usług + błąd gatewaya), porównanie z makietami M1/M5.

### Faza 4 — Rozliczenie zwrotne
13. Spike: potwierdzić mechanizm programowego wyszukania rekordu po wartości custom field (`payment_link_id === linkId`) poza kontekstem `DataTable`; w razie braku — dodać symetryczny custom field `visit_id` po stronie `checkout:checkout_link`.
14. Subskrybent `patient/subscribers/payment-link-completed.ts` na `checkout.transaction.completed`: odnajduje wizytę, ustawia `payment_received_at`/`payment_link_status`. Test: symulacja eventu → wizyta ma ustawione pole.
15. Blokada `unconfirm` dla opłaconej wizyty (409 `visit_already_paid`, wg [M2](assets/vpay-ui-02-oplacona-blokada-cofniecia.png)) + dezaktywacja linku (`CheckoutLink.status = 'inactive'`) przy `unconfirm` nieopłaconej wizyty. Test: `unconfirm` opłaconej wizyty → 409; `unconfirm` nieopłaconej → link `inactive`, ponowne `confirm` → nowy `slug`.
16. Pełny przebieg end-to-end (manualny lub E2E): potwierdzenie → link → płatność testowa w Stripe (tryb testowy) → webhook → `payment_received_at` ustawione → próba `unconfirm` zablokowana.

## 📝 Non-goals

Publiczna rezerwacja wizyt i jakakolwiek płatność inicjowana spoza panelu `/backend` (zakres [PBOOK](2026-10-01-public-visit-booking-website.md), osobna, niezależna specyfikacja); wybór/dodanie nowego dostawcy płatności poza już zainstalowanym `gateway_stripe`; zwroty/refundy inicjowane z poziomu wizyty (obsługiwane ogólnie przez `payment_gateways`, nie w zakresie tej specyfikacji); faktury/dokumenty sprzedażowe (`sales`); wielowalutowość; automatyczne przypomnienia/ponowne wysyłki linku po terminie (`scheduler`) — do rozważenia w kolejnej iteracji; automatyczna zmiana statusu/`isSettled` wizyty na podstawie `payment_received_at` (rejestracja nadal rozlicza ręcznie — `payment_received_at` to tylko sygnał wspomagający).
