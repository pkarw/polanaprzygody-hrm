# Patient — kalendarz wizyt i kontrola dostępności

**Date**: 2026-09-30
**Status**: Ready for implementation
**Spec ID**: VCAL
**Zakres**: pełna implementacja VCAL-1 i VCAL-2.
**Zależność**: [VIS — wizyty pacjenta](2026-09-29-patient-visits.md), faza VIS-1 (ten sam moduł `patient`). VIS zależy od [PAT](2026-09-29-patient-ehr-base.md) faza PAT-1.
**Tryb**: run autonomiczny — brama Open Questions rozstrzygnięta domyślnymi wartościami, patrz [Resolved assumptions](#resolved-assumptions-autonomous-defaults). Użytkownik potwierdził te założenia zleceniem pełnej, autonomicznej implementacji 2026-09-30.

## Implementation status

| Phase | Status | Tracking |
|---|---|---|
| VCAL-1 — kontrola dostępności | implemented; checkpoint passed | `.ai/runs/2026-09-30-patient-visits-calendar-and-availability/checkpoint-1-checks.md` |
| VCAL-2 — kalendarz | planned | `.ai/runs/2026-09-30-patient-visits-calendar-and-availability/PLAN.md` |

## TLDR

Wizyty (VIS) mają listę i formularz. VCAL dokłada dwie rzeczy w tym samym module `patient`:

1. **Widok kalendarza** `/backend/patient/visits/calendar` — te same rekordy `patient:patient_visit` w siatce dzień/tydzień/miesiąc/agenda, na współdzielonym prymitywie `ScheduleView` z `@open-mercato/ui/backend/schedule`. Kliknięcie w wolny slot zakłada wizytę, kliknięcie w wizytę ją otwiera. Kalendarz da się zawęzić do jednego terapeuty i do jednego gabinetu.
2. **Kontrolę dostępności** wykonawcy i gabinetu, egzekwowaną **w komendzie zapisu**, a więc obowiązującą identycznie z kalendarza i z istniejącego formularza dostępnego z listy wizyt.

Nie budujemy własnego silnika dostępności — platforma już go ma, a moduł `patient` po prostu go nie czyta:

- `planner:planner_availability_rule` — `subject_type` = `member` \| `resource` \| `ruleset`, `rrule` + `exdates`, `kind` = `availability` \| `unavailability`;
- **zaakceptowany wniosek urlopowy `staff:staff_leave_request` sam zakłada reguły `kind='unavailability'`** dla `subject_type='member'` (`staff/commands/leave-requests.ts`, `createUnavailabilityRules`, wywołane z akcji accept), razem z `unavailability_reason_entry_id`/`unavailability_reason_value` — urlop i zwolnienie są więc już w tym samym strumieniu danych co grafik i nie wymagają osobnego odczytu tabeli wniosków;
- `resources:resources_resource.availability_rule_set_id` + `is_active` — dostępność gabinetu przez zestaw reguł;
- `plannerAvailabilityService.getMergedAvailabilityWindows({ rules, range })` (token DI zarejestrowany w `planner/di.ts`, implementacja `planner/lib/availabilityMerge.ts`) — scalanie okien dostępności minus niedostępności, jedno źródło prawdy dla siatki i dla walidacji serwerowej.

VCAL nie dodaje żadnej tabeli grafiku i żadnej relacji ORM między modułami. Dodaje: usługę odczytu dostępności w `patient`, dwa odczytowe API, sprawdzenie w komendach zapisu wizyty, powierzchnię kalendarza i cztery pola audytu świadomego nadpisania ostrzeżenia.

## Problem Statement

1. **Rejestracja planuje w siatce godzin, nie w tabeli.** Lista wizyt VIS pokazuje wiersze posortowane po `starts_at`; nie widać z niej dziury w grafiku ani nakładających się terminów, więc planista i tak prowadzi drugi kalendarz obok systemu. Taki drugi kalendarz jest źródłem rozbieżności, których nie da się wykryć testem.
2. **VIS jawnie wpisała konflikty grafiku w non-goals** i zostawiła ryzyko z własną tabelą ryzyk: *„Nakładające się wizyty → Planista sprawdza grafik ręcznie”*. Brief zamyka dokładnie to ryzyko: wizyta nie ma powstać dla osoby na urlopie lub zwolnieniu ani w niedostępnym gabinecie.
3. **Sprawdzenie musi działać też z listy wizyt.** Gdyby mieszkało w komponencie kalendarza, formularz z listy pozostałby dziurą, przez którą wjeżdżają dokładnie te rekordy, którym mamy zapobiec. Dlatego jego miejscem jest komenda zapisu; kalendarz i formularz pokazują ten sam wynik wcześniej, jako podpowiedź.
4. **Dane dostępności już istnieją i są utrzymywane** w `staff` (wnioski urlopowe i ich akceptacja), `planner` (reguły) i `resources` (gabinety i ich zestawy reguł), ale moduł `patient` ich nie czyta. Wiedza organizacji o nieobecnościach nie dociera do momentu, w którym jest potrzebna.
5. **Widok pojedynczego terapeuty jest dziś niemożliwy.** `staff` pokazuje własną dostępność członka zespołu (`/backend/staff/my-availability`), ale nie zestawia jej z wizytami pacjentów; kalendarz CRM pokazuje interakcje `customers`, nie wizyty.

Źródło: brief użytkownika 2026-09-30 wraz ze zrzutem kalendarza CRM (`/backend/calendar`) jako referencją wizualną; ustalenia techniczne z odczytu zainstalowanego pakietu `@open-mercato/core` w wersji podanej niżej.

## Overview and Success Measures

- **Primary outcome:** planista widzi grafik wybranego terapeuty i zakłada w nim wizytę bez opuszczania widoku, a zapis wizyty kolidującej z nieobecnością wykonawcy albo z niedostępnym gabinetem nie przechodzi po cichu — kończy się odmową albo świadomym, podpisanym nadpisaniem.
- **Leading indicators:** odsetek wizyt zakładanych z kalendarza zamiast z listy; liczba wykrytych kolizji na 100 zapisów; liczba nadpisań z powodem (rośnie na starcie, powinna maleć, gdy grafiki się ustabilizują); zero zapisów kolidujących bez zarejestrowanej decyzji operatora.
- **Baseline:** 0 — VIS nie jest jeszcze zaimplementowana, więc dziś nie ma ani kalendarza, ani żadnej kontroli kolizji. Pierwszy pomiar po VCAL-1 na danych organizacji pilotażowej.
- **Market / product reference:** sprawdzone 2026-09-30. [Cal.com](https://github.com/calcom/cal.com) modeluje dostępność jako *schedule* = powtarzalne przedziały + nadpisania dat, i liczy wolne sloty odejmując rezerwacje od okien dostępności — dokładnie kształt, który `planner` już ma; przyjmujemy ten podział (reguły osobno, rezerwacje osobno, slot = różnica), odrzucamy jego publiczny link rezerwacyjny i strefowe negocjacje z zapraszanym, bo VCAL jest narzędziem rejestracji, nie portalem pacjenta. [OpenEMR](https://github.com/openemr/openemr) prowadzi kalendarz z blokadą slotu i kategoriami wizyt; przyjmujemy pojęcie *blokującej nieobecności prowadzącego*, odrzucamy jego wbudowany moduł urlopów, bo `staff` już nim jest. Ograniczenia dostępu do zewnętrznych witryn opisuje PAT.

## Goals

| ID | Wynik |
|---|---|
| VCAL-R01 | Widok kalendarza wizyt w dzień/tydzień/miesiąc/agenda, pokazujący te same rekordy co lista wizyt, z zachowaniem zakresu i uprawnień |
| VCAL-R02 | Założenie wizyty przez wskazanie wolnego slotu i edycja wizyty przez wskazanie jej w kalendarzu, bez opuszczania widoku |
| VCAL-R03 | Kalendarz zawężony do wybranego terapeuty (oraz do gabinetu), z pasmami jego dostępności i nieobecności w tle |
| VCAL-R04 | Sprawdzenie dostępności wykonawcy — nieobecność z zaakceptowanego wniosku urlopowego/zwolnienia, ręczny wyjątek w grafiku, termin poza grafikiem, podwójna rezerwacja — działające tak samo z kalendarza i z formularza listy |
| VCAL-R05 | Sprawdzenie dostępności gabinetu — zasób nieaktywny, niedostępny regułą, termin poza jego grafikiem, zajęty inną wizytą |
| VCAL-R06 | Rozróżnienie odmowy od ostrzeżenia oraz świadome nadpisanie ostrzeżenia z powodem, autorem i czasem w audycie |
| VCAL-R07 | Czytelna degradacja, gdy moduł dostępności jest wyłączony albo jego odczyt zawiedzie — praca nie staje, ale użytkownik wie, że kontrola nie działa |
| VCAL-R08 | Scoping, współbieżność, uprawnienia i prywatność powodu nieobecności na każdej nowej powierzchni |

## Non-goals

Przeciąganie i rozciąganie wizyt myszą (drag-and-drop), wizyty cykliczne, automatyczna rezerwacja zasobu i zwalnianie jej po anulowaniu, propozycje „najbliższy wolny termin”, kolejka oczekujących, overbooking z limitem, kalendarz publiczny lub portal pacjenta, samodzielne rezerwowanie przez pacjenta, powiadomienia i przypomnienia o wizycie, synchronizacja z Google/Outlook, wiele osób realizujących jedną wizytę, wiele gabinetów na wizytę, edycja reguł dostępności z poziomu `patient` (należy do `planner`, `staff` i `resources`), tworzenie i akceptowanie wniosków urlopowych z poziomu `patient`, konflikt z wydarzeniami kalendarza CRM (`customers`) — patrz Q3 w [Resolved assumptions](#resolved-assumptions-autonomous-defaults) i szew rozszerzenia w [Architecture](#architecture-and-data-flow), rozliczenia, płatności i ceny (pozostają jak w VIS).

VCAL nie zmienia modelu wizyty VIS poza czterema polami audytu nadpisania i nie zmienia żadnego kontraktu modułów `staff`, `resources` ani `planner` — czyta je wyłącznie.

## Proposed Solution

Trzy warstwy, każda z jednym właścicielem.

**1. Odczyt dostępności — `patientAvailabilityService` (nowy token DI w `patient/di.ts`).** Dla zadanego zakresu czasu i listy podmiotów (`member:<teamMemberId>`, `resource:<resourceId>`) serwis:

- czyta `planner_availability_rules` przez `EntityManager`, filtrując po `tenant_id`, `organization_id`, `subject_type` i `subject_id` oraz `deleted_at IS NULL` — odczyt skalarny po ID, bez relacji ORM między modułami i bez klucza obcego;
- dla gabinetu dokłada reguły jego `availability_rule_set_id` (`subject_type='ruleset'`), tak jak robi to karta zasobu;
- scala okna przez zainstalowany `plannerAvailabilityService.getMergedAvailabilityWindows({ rules, range })` — tę samą funkcję, której używa UI dostępności w `planner`, `staff` i `resources`, więc siatka i walidacja nigdy się nie rozjeżdżają;
- zwraca okna dostępności, okna niedostępności z ich pochodzeniem (`leave` gdy reguła niesie `unavailability_reason_*`, `manual` w przeciwnym razie) i znacznik `unknown`, gdy moduł `planner` jest wyłączony albo odczyt zawiódł;
- rozwiązuje `resources_resources.is_active` i `deleted_at` dla wskazanego gabinetu.

**2. Wykrywanie kolizji — `evaluateVisitConflicts` (czysta funkcja w `patient/lib/`).** Dostaje okna z punktu 1, nakładające się wizyty z własnej tabeli i szkic wizyty; zwraca listę konfliktów, każdy z `code`, `severity`, podmiotem, oknem i stabilną sygnaturą. Funkcja jest czysta, więc ma testy jednostkowe niezależne od bazy, a ten sam wynik obsługuje probe odczytowe i ścieżkę zapisu.

**3. Egzekucja — w komendach `patient.visits.create` i `patient.visits.update` (VIS), wewnątrz tej samej transakcji i tej samej blokady rekordu.** Klientowi nigdy się nie ufa: wynik probe jest podpowiedzią, decyduje przeliczenie po stronie serwera, po zajęciu blokady, tuż przed zapisem. Blokujący konflikt kończy zapis błędem 422; ostrzegawczy wymaga jawnego potwierdzenia sygnatur i powodu, inaczej też 422 z listą do pokazania.

Powierzchnia UI to jedna nowa strona (`ScheduleView` + pasek filtrów + dialogi VIS) i jeden nowy blok ostrzeżeń wstrzykiwany do istniejącego formularza wizyty — ten sam komponent w obu miejscach, więc zachowanie jest identyczne niezależnie od punktu wejścia.

### Design Decisions and Alternatives

| Decyzja | Powód | Alternatywa rozważona | Dlaczego odrzucona / odroczona |
|---|---|---|---|
| Czytamy reguły `planner`, nie tabelę wniosków `staff` | Akceptacja wniosku sama tworzy regułę `unavailability`; jeden strumień obejmuje urlop, zwolnienie i ręczny wyjątek | Odczyt `staff_leave_requests` | Dublowałby logikę statusów i uznawałby wniosek `pending` za nieobecność, której jeszcze nie ma |
| Egzekucja w komendzie, nie w komponencie | Brief wymaga tego samego sprawdzenia z kalendarza i z listy; komenda jest jedynym wspólnym punktem obu ścieżek oraz API | Walidacja w formularzu | Zostawia API i drugi formularz bez ochrony |
| Scalanie przez zainstalowany `plannerAvailabilityService` | Siatka i walidacja liczą z tej samej funkcji; zero rozjazdu prezentacji z decyzją | Własny parser `rrule` w `patient` | Drugie źródło prawdy o dostępności, którego nikt nie utrzymuje razem z `planner` |
| Dwie wagi konfliktu: blokująca i ostrzegawcza | Nieobecność osoby to fakt do poprawienia w `staff`; nadgodziny i podwójna rezerwacja to decyzja organizacji | Wszystko blokuje | Blokuje pilne przypadki i uczy obchodzenia systemu przez fałszowanie terminu |
| | | Wszystko ostrzega | Sprawdzenie nigdy niczego nie zapobiega, więc nie realizuje briefu |
| Nadpisanie wymaga sygnatur konfliktów, nie samej flagi | Potwierdzenie dotyczy konkretnych, pokazanych kolizji; zmiana sytuacji między podglądem a zapisem unieważnia zgodę | `force: true` | Pozwala nadpisać kolizję, której operator nigdy nie widział |
| Brak `ends_at` = chwila, nie domyślny czas trwania | VIS mówi wprost, że brak końca oznacza *nieznany* czas trwania; domyślne 60 minut wymyślałoby zajętość, której nikt nie deklarował | Domyślna długość z konfiguracji | Nowa zależność od modułu konfiguracji i cicha zmiana znaczenia pola VIS |
| `ScheduleView` z `@open-mercato/ui/backend/schedule` | Prymityw design systemu; ma dzień/tydzień/miesiąc/agenda, wybór slotu, semantyczne tokeny statusu i oba motywy; używany już przez `planner`, `staff` i `resources` | Odtworzenie ekranu CRM `customers/components/calendar/*` | To wewnętrzna powierzchnia modułu `customers`, nie publiczny kontrakt; import spoza modułu wiąże `patient` z prywatnym API, a kopia zakłada drugą rodzinę komponentów wprost zakazaną w `.ai/guides/backend-ui.md` |
| Osobna strona kalendarza + przełącznik Lista/Kalendarz | Kalendarz ma własny zakres, filtry i uprawnienie do odczytu; `DataTable` i siatka nie dzielą stanu paginacji | Tryb wewnątrz listy wizyt | Miesza dwa modele zakresu (strona vs przedział czasu) w jednym adresie |
| Powód nieobecności tylko dla `staff.view` | `unavailability_reason_value` to informacja kadrowa; rejestracja musi znać zajętość, nie diagnozę urlopu | Pokazywać powód każdemu z `visits.manage` | Rozszerza dostęp do danych HR bez decyzji właściciela modułu |
| Degradacja odczytu dostępności jest jawna i nie blokuje | To kontrola operacyjna, nie zabezpieczenie; awaria odczytu nie może zatrzymać rejestracji | Fail closed na odczycie dostępności | Pojedynczy błąd `planner` zatrzymałby zakładanie wizyt w całej organizacji |

## Domain Vocabulary and Business Rules

| Termin / niezmiennik | Znaczenie | Źródło prawdy | Zachowanie przy naruszeniu |
|---|---|---|---|
| Okno dostępności | Przedział, w którym podmiot może przyjmować, po odjęciu niedostępności | `planner_availability_rules` scalone przez `plannerAvailabilityService` | Brak okien ≠ niedostępność; patrz reguła 3 |
| Nieobecność kadrowa | Okno `kind='unavailability'` z niepustym `unavailability_reason_entry_id` lub `unavailability_reason_value` | Reguła utworzona przez akceptację `staff_leave_request` | Blokuje zapis (422), bez możliwości nadpisania |
| Ręczny wyjątek | Okno `kind='unavailability'` bez powodu kadrowego | Reguła założona ręcznie w `planner`/`staff`/`resources` | Ostrzega, można nadpisać z powodem |
| Poza grafikiem | Termin poza wszystkimi oknami dostępności podmiotu, który ma choć jedną regułę `availability` | To samo scalenie | Ostrzega |
| Brak grafiku | Podmiot nie ma żadnej reguły `availability` | To samo scalenie | Informacja; nie blokuje i nie wymaga potwierdzenia |
| Podwójna rezerwacja | Inna wizyta tego samego wykonawcy lub gabinetu, `deleted_at IS NULL`, `status NOT IN ('cancelled')`, o nakładającym się oknie | `patient_visits` w tym samym scope | Ostrzega |
| Zajętość gabinetu | Suma: zasób nieaktywny/usunięty, niedostępny regułą, poza grafikiem, zajęty inną wizytą | `resources_resources` + reguły + `patient_visits` | Nieaktywny blokuje; reszta ostrzega |
| Sygnatura konfliktu | Stabilny skrót `code + subjectType + subjectId + okno zaokrąglone do minuty` | Wyliczana serwerowo | Zmiana zbioru sygnatur unieważnia wcześniejsze potwierdzenie |
| Nadpisanie | Zapis mimo ostrzeżeń, z potwierdzeniem dokładnie tych sygnatur i powodem | `patient_visits.conflict_override_*` | Bez kompletu sygnatur lub bez powodu — 422 |
| Nieznany czas trwania | `ends_at IS NULL` | VIS | Do kolizji liczy się jako chwila `starts_at`; kalendarz rysuje blok orientacyjny i oznacza go jako nieznany |

**Reguły:**

1. Nakładanie się liczone jest na półotwartych przedziałach `[starts_at, ends_at)` w UTC. Wizyta kończąca się dokładnie wtedy, gdy zaczyna się następna, **nie** koliduje. Dla `ends_at IS NULL` przedziałem jest chwila `starts_at`, więc taka wizyta koliduje tylko wtedy, gdy wpada w środek cudzego okna; dwie wizyty bez końca o tej samej godzinie kolidują.
2. Anulowana wizyta (`status='cancelled'`) i miękko usunięta nie zajmują ani wykonawcy, ani gabinetu. `no_show` i `completed` zajmują — zdarzyły się i blokowały czas.
3. Brak jakiejkolwiek reguły `availability` dla podmiotu oznacza *grafik nieokreślony*, nie *niedostępny*. Organizacja, która nie prowadzi grafików, ma dostać ostrzeżenia o podwójnej rezerwacji i o nieobecnościach, a nie ostrzeżenie przy każdym zapisie.
4. Kontrola dotyczy wyłącznie wizyt w stanie `planned`. Przejścia `complete`, `cancel`, `no_show`, `settle`, `confirm` i `reopen` nie uruchamiają jej ponownie — nie zmieniają terminu ani obsady. `reopen` do `planned` również nie, bo nie zmienia okna; kolejna edycja terminu już tak.
5. Konflikty liczone są po odrzuceniu samego edytowanego rekordu (`excludeVisitId`), również gdy zmienia się tylko opis — wtedy zbiór konfliktów zwykle jest pusty i nic nie trzeba potwierdzać.
6. Nadpisanie wymaga feature `patient.visits.override_conflict`, kompletu sygnatur pokazanych ostrzeżeń i niepustego powodu (1–2000 znaków). Powód jest szyfrowany jak pozostałe wolne teksty PAT i nigdy nie trafia do zdarzeń ani logów.
7. Zapis bez żadnego ostrzeżenia czyści pola nadpisania. Historia nadpisań żyje w audycie komend, nie w rekordzie — rekord trzyma stan ostatniego zapisu.
8. Nieobecność kadrowa blokuje **zawsze**, także przy nadpisaniu i także dla użytkownika z `override_conflict`. Ścieżka naprawy prowadzi przez `staff`: skrócić albo odrzucić wniosek urlopowy, wtedy reguła znika i zapis przechodzi. Dzięki temu `patient` nigdy nie twierdzi czegoś, czemu przeczy moduł kadrowy.
9. Nieaktywny lub usunięty gabinet blokuje, co jest zgodne z regułą VIS o aktywnej nowej referencji; to ta sama zasada wyrażona jako konflikt, a nie drugi, konkurencyjny warunek.
10. Kontrola jest sprawdzeniem operacyjnym, nie zabezpieczeniem. Wyprowadzenie `tenantId`/`organizationId` i ACL działają fail closed niezależnie od niej; sam odczyt dostępności przy awarii degraduje się jawnie i nie zatrzymuje pracy.
11. Kalendarz pokazuje wyłącznie rekordy, które użytkownik i tak zobaczyłby na liście wizyt — ten sam scope i ten sam feature. Pasma dostępności w tle pokazują zajętość; powód nieobecności dopisywany jest tylko posiadaczowi `staff.view` (dla osób) lub `resources.view` (dla gabinetów).
12. Wizyta pokazana w kalendarzu nie ujawnia danych klinicznych: kafel niesie godzinę, nazwisko pacjenta, wykonawcę, gabinet i status. Opis organizacyjny i usługi widać dopiero po otwarciu wizyty, pod uprawnieniami VIS.

### Macierz konfliktów

| Kod | Podmiot | Warunek | Waga | Uzasadnienie |
|---|---|---|---|---|
| `member_absence` | wykonawca | Okno `unavailability` z powodem kadrowym nakłada się na termin | **blokuje** | Osoby fizycznie nie ma; poprawka należy do `staff` |
| `member_unavailable` | wykonawca | Okno `unavailability` bez powodu kadrowego | ostrzega | Ręczny wyjątek w grafiku bywa świadomie łamany |
| `member_outside_availability` | wykonawca | Ma reguły `availability`, termin poza nimi | ostrzega | Nadgodziny to decyzja organizacji |
| `member_no_schedule` | wykonawca | Brak reguł `availability` | informuje | Brak grafiku nie jest niedostępnością |
| `member_double_booked` | wykonawca | Inna niezanulowana wizyta nakłada się na termin | ostrzega | Bywa zamierzone (konsultacja, zajęcia grupowe) |
| `resource_inactive` | gabinet | `is_active=false` lub `deleted_at IS NOT NULL` | **blokuje** | Zgodne z regułą VIS o aktywnej referencji |
| `resource_unavailable` | gabinet | Okno `unavailability` zasobu lub jego zestawu reguł | ostrzega | |
| `resource_outside_availability` | gabinet | Ma reguły `availability`, termin poza nimi | ostrzega | |
| `resource_double_booked` | gabinet | Inna niezanulowana wizyta w tym gabinecie | ostrzega | Terapia grupowa i wizyty rodzinne bywają zamierzone |
| `availability_unknown` | dowolny | `planner` wyłączony albo odczyt reguł zawiódł | informuje | Degradacja jawna, praca nie staje |

Informacja (`info`) jest pokazywana, ale nie wymaga potwierdzenia i nie blokuje. Zmiana wagi któregokolwiek kodu jest zmianą zachowania widocznego dla użytkownika i wymaga aktualizacji tej tabeli razem z testami.

## Users, Permissions, and Scope

| Aktor | Dozwolone wyniki | Zasada zakresu | Wymagane feature IDs |
|---|---|---|---|
| Rejestracja / planista | Kalendarz, zakładanie i edycja wizyt, widok ostrzeżeń | własna organizacja | `patient.visits.view`, `patient.visits.manage`, `patient.patients.view` |
| Planista z prawem nadpisania | To samo + nadpisanie ostrzeżeń z powodem | własna organizacja | dodatkowo `patient.visits.override_conflict` |
| Koordynator grafiku | Kalendarz terapeuty z pasmami i powodami nieobecności | własna organizacja | dodatkowo `staff.view` (osoby) i/lub `resources.view` (gabinety) |
| Podgląd bez prawa zapisu | Kalendarz tylko do odczytu, bez akcji tworzenia i edycji | własna organizacja | `patient.visits.view`, `patient.patients.view` |

Nowy feature: **`patient.visits.override_conflict`**, deklarowany w `patient/acl.ts`, zależny od `patient.visits.manage` (który implikuje `view`). Rola bez niego widzi ostrzeżenia i przycisk odmawia — a próba wysłania nadpisania ręcznie kończy się 403 bez żadnego zapisu.

`tenantId` i `organizationId` pochodzą wyłącznie z serwerowego auth i wybranej organizacji; API nie przyjmuje ich w payloadzie, brak lub niezgodność są odrzucane fail closed. Żadna operacja VCAL nie używa zakresu systemowego (`organizationId: null`) — kalendarz wizyt zawsze należy do konkretnej organizacji.

**Rozdzielenie egzekucji od widoczności.** Sprawdzenie na ścieżce zapisu jest niezmiennikiem domenowym i liczy się z kompletu danych, niezależnie od tego, jakie uprawnienia odczytu ma operator. Ścieżka odczytu (probe i pasma kalendarza) zwraca tylko to, co użytkownik może zobaczyć: bez `staff.view` nieobecność osoby pokazuje się jako „Niedostępny w tym terminie” bez powodu i bez rozróżnienia urlop/zwolnienie/wyjątek; bez `resources.view` analogicznie dla gabinetu. Dzięki temu kontrola nigdy nie osłabia się przez brak uprawnień operatora, a jednocześnie nie staje się kanałem wycieku danych kadrowych.

## Reuse and Ownership Map

**Installed-version:** `0.8.1-develop.7266.1.8e520bbe03` — zgodna z VIS i z `package.json`; moduły `planner`, `resources` i `staff` są włączone w `src/modules.ts`.

| Zdolność | Reuse / extend / app-own | Moduł | Szew integracji | Dlaczego |
|---|---|---|---|---|
| Rekord wizyty | app-owned (VIS) | `patient` | `patient:patient_visit` | VCAL dokłada tylko pola audytu nadpisania |
| Reguły dostępności osoby | reuse | `planner` | Odczyt skalarny po `subject_type='member'`, `subject_id=staff_team_member.id` | Jedno źródło; brak duplikatu w `patient` |
| Urlop i zwolnienie | reuse pośredni | `staff` → `planner` | Akceptacja wniosku tworzy regułę `unavailability` z powodem | Nie interpretujemy statusów wniosków; `pending` z definicji nie blokuje |
| Reguły dostępności gabinetu | reuse | `planner` + `resources` | `subject_type='resource'` oraz `'ruleset'` z `availability_rule_set_id` | Tak samo składa je karta zasobu |
| Scalanie okien | reuse | `planner` | Token DI `plannerAvailabilityService` | Ta sama funkcja dla siatki i walidacji |
| Aktywność gabinetu | reuse | `resources` | Odczyt `is_active`, `deleted_at` | Zgodne z regułą VIS o aktywnej referencji |
| Siatka kalendarza | reuse | `@open-mercato/ui` | `ScheduleView`, `ScheduleItem`, `ScheduleSlot`, `getScheduleItemStyle` | Prymityw design systemu, oba motywy, semantyczne tokeny |
| Pickery referencji | reuse | `staff`, `resources`, `patient` | `GET /api/staff/team-members`, `GET /api/resources/resources`, `GET /api/patient/patients` | Te same źródła, które VIS już wskazała |
| Formularz i dialogi wizyty | reuse | `patient` (VIS) | `CrudForm` host `crud-form:patient.visit` | Kalendarz otwiera ten sam formularz, nie drugi |
| Wzorzec ostrzeżenia o kolizji | wzorzec | `customers` | `lib/calendar/conflicts.ts` | Precedens spójności siatki i edytora; kopiujemy zasadę, nie kod |
| Zapis, blokady, audyt | reuse | `patient` (VIS) | Komendy, `expectedUpdatedAt`, efekty post-commit | Kontrola mieści się w istniejącej transakcji |

Nie zapisujemy w `patient` żadnej kopii urlopów, grafików ani rezerwacji zasobów. Powiązanie wizyty z gabinetem nadal **nie jest** rezerwacją w rozumieniu `resources` — jest informacją, którą VCAL potrafi teraz skonfrontować z grafikiem. Brak nowych zależności npm: `react-big-calendar` i `date-fns` przychodzą z zainstalowanym `@open-mercato/ui`.

## Architecture and Data Flow

```text
Kalendarz /backend/patient/visits/calendar          Formularz wizyty (lista lub kalendarz)
   │  GET /api/patient/visits/calendar                 │  GET /api/patient/visits/availability-check
   │      ?from&to&teamMemberId&resourceId             │      ?teamMemberId&startsAt&endsAt&resourceId&excludeVisitId
   ▼                                                   ▼
patientAvailabilityService (DI, moduł patient)
   ├─ em.find(PlannerAvailabilityRule, { tenantId, organizationId, subjectType, subjectId })   ← odczyt skalarny
   ├─ em.find(ResourcesResource, { id, tenantId, organizationId })                             ← is_active, ruleSetId
   ├─ plannerAvailabilityService.getMergedAvailabilityWindows({ rules, range })                ← token DI planner
   └─ em.find(PatientVisit, nakładające się, status != cancelled, deleted_at IS NULL)          ← własna tabela
   ▼
evaluateVisitConflicts(draft, windows, overlaps) → Conflict[] { code, severity, subject, window, signature }
   ▼
POST/PUT /api/patient/visits → patient.visits.create / patient.visits.update
   └─ w transakcji, po blokadzie rekordu i sprawdzeniu expectedUpdatedAt:
        przelicz konflikty ponownie z danych serwera
        blocking          → 422 visit_conflict_blocking        (bez zapisu)
        warning bez zgody → 422 visit_conflict_unacknowledged  (bez zapisu)
        warning ze zgodą  → zapis + conflict_override_* + commit
        brak ostrzeżeń    → zapis + wyczyszczenie conflict_override_*
   ▼
commit → zdarzenia post-commit (patient.visit.updated, patient.visit.conflict_overridden) → odświeżenie siatki
```

- **Granice modułów:** VCAL nie tworzy nowego modułu. Wizyta, jej kalendarz i jej kontrola muszą być spójne transakcyjnie z rekordem wizyty, więc mieszkają w `patient` razem z VIS. `planner`, `staff` i `resources` pozostają właścicielami grafików i nie są modyfikowane.
- **Szwy rozszerzeń:** `evaluateVisitConflicts` przyjmuje listę *dostawców zajętości*; wbudowany dostawca czyta `patient_visits`. Rozszerzenie o wydarzenia kalendarza CRM albo o rezerwacje innego modułu to dołożenie dostawcy, nie przepisanie reguł — bez zmiany kontraktu API i bez zmiany kodów konfliktów. Pasek filtrów kalendarza korzysta z istniejących pickerów hostów; ostrzeżenia w formularzu wchodzą przez host `crud-form:patient.visit`.
- **Zachowanie przy braku modułu:** obecność `planner`, `staff` i `resources` sprawdzana jest tak, jak robi to strona kalendarza CRM — przez rejestr modułów po stronie serwera. Bez `planner` kontrola dostępności milknie, zostaje wykrywanie podwójnej rezerwacji z własnej tabeli, a UI mówi o tym raz, w widocznym miejscu, zamiast udawać, że sprawdziła.
- **Rozważona prostsza alternatywa:** liczyć konflikty tylko w kliencie kalendarza, jak robi to `findConflicts` w CRM. Odrzucona, bo brief wymaga sprawdzenia także przy zapisie z listy, a kontrola żyjąca w komponencie nie chroni API.
- **Kompatybilność:** VIS-owe `GET/POST/PUT/DELETE /api/patient/visits` zachowują kształt. Nowe pola odpowiedzi są dodatkowe; nowe pola żądania opcjonalne. Żądanie bez `conflictOverride` zachowuje się dokładnie jak dziś, dopóki nie ma ostrzeżeń — a gdy są, dostaje 422 z listą, czyli nowe zachowanie na nowym warunku, nie zmiana istniejącego. `ends_at` pozostaje opcjonalne w API; kalendarz wypełnia je z wybranego slotu.

## User Journeys

### VCAL-J1 — Tydzień terapeuty i wizyta z wolnego slotu

1. Planista otwiera „Kalendarz wizyt”, wybiera w pasku terapeutę „Anna Nowicka”. Siatka tygodnia pokazuje jej wizyty, a w tle jasne pasma godzin pracy i szare pasma nieobecności.
2. Klika pusty slot wtorek 10:00–11:00. Otwiera się dialog nowej wizyty z wypełnionym terminem, strefą i wykonawcą; pacjenta i gabinet wybiera z pickerów.
3. Pod polami terminu pojawia się status sprawdzenia: „Termin wolny — Anna Nowicka, Gabinet 2”.
4. Zapis kończy się sukcesem, dialog znika, kafel pojawia się w siatce bez przeładowania strony, komunikat sukcesu jest ogłaszany asystująco.
5. Niepowodzenie zapisu zachowuje treść dialogu; konflikt wersji (409) pokazuje komunikat i pozwala odświeżyć rekord bez utraty wpisanych danych.

### VCAL-J2 — Ostrzeżenie i świadome nadpisanie

1. Planista przesuwa wizytę na godzinę, w której terapeuta ma już inną wizytę.
2. Sprawdzenie zwraca ostrzeżenie „Podwójna rezerwacja: Anna Nowicka ma wizytę 10:30–11:30”. Przycisk zapisu pozostaje aktywny, ale zmienia się w „Zapisz mimo ostrzeżeń”.
3. Kliknięcie otwiera potwierdzenie z listą ostrzeżeń i wymaganym polem powodu. Bez powodu przycisk odmawia i fokus wraca na pole.
4. Po zapisie wizyta ma znacznik „Zapisana mimo ostrzeżeń”, a kto, kiedy i dlaczego zostaje w rekordzie i w audycie.
5. Użytkownik bez `patient.visits.override_conflict` nie widzi potwierdzenia — widzi ostrzeżenia i komunikat, że zapis wymaga uprawnienia; ręcznie wysłane żądanie dostaje 403 i nic nie zapisuje.

### VCAL-J3 — Nieobecność blokuje i ma ścieżkę naprawy

1. Planista wybiera termin w dniu, na który terapeuta ma zaakceptowany urlop.
2. Sprawdzenie zwraca odmowę: „Anna Nowicka jest nieobecna 5–9 października”. Przycisk zapisu jest wyłączony, a nie tylko ozdobiony ostrzeżeniem.
3. Komunikat mówi wprost, co zrobić: wybrać inny termin albo innego wykonawcę, a jeśli urlop jest nieaktualny — skrócić lub odrzucić wniosek w module kadrowym. Osoba z `staff.leave_requests.manage` dostaje odnośnik do wniosku; pozostali widzą samą instrukcję.
4. Po zmianie w `staff` reguła znika, ponowne sprawdzenie przechodzi i zapis się udaje.

### VCAL-J4 — Gabinet

1. Planista wybiera gabinet zajęty przez inną wizytę w tym samym czasie: ostrzeżenie z nazwą gabinetu i godzinami kolizji, nadpisanie możliwe.
2. Wybiera gabinet oznaczony jako nieaktywny: odmowa, bez nadpisania, z podpowiedzią wyboru innego gabinetu.
3. Filtr gabinetu w kalendarzu pokazuje obłożenie jednego pomieszczenia — te same wizyty, pasma dostępności zasobu w tle.

### VCAL-J5 — To samo sprawdzenie z listy wizyt

1. Planista otwiera wizytę z listy `/backend/patient/visits`, nie dotykając kalendarza.
2. Zmienia wykonawcę na osobę przebywającą na zwolnieniu. Ten sam blok ostrzeżeń pojawia się w formularzu, z tym samym tekstem i tą samą wagą.
3. Zapis jest odrzucony z tym samym kodem błędu co z kalendarza. Żaden punkt wejścia nie ma słabszej kontroli.

### VCAL-J6 — Degradacja

1. Organizacja wyłącza moduł `planner`. Kalendarz działa, pasma dostępności znikają, a w miejscu filtrów pojawia się jednorazowa informacja, że kontrola dostępności jest wyłączona.
2. Sprawdzenie nadal wykrywa podwójne rezerwacje z własnej tabeli i nadal blokuje nieaktywny gabinet.
3. Przy przejściowym błędzie odczytu reguł zapis nie jest blokowany, ale odpowiedź niesie `availability_unknown`, UI mówi „Nie udało się sprawdzić grafiku”, a zdarzenie trafia do logu technicznego bez danych osobowych.

## UI and Interaction Contracts

Najbliższe istniejące powierzchnie zainstalowane, sprawdzone przed projektem: `node_modules/@open-mercato/core/src/modules/customers/backend/calendar/page.tsx` (strona kalendarza w `Page`/`PageBody` z serwerowym rozpoznaniem modułów opcjonalnych), `node_modules/@open-mercato/core/src/modules/planner/components/AvailabilitySchedule.tsx` (użycie `ScheduleView` z dialogiem `CrudForm` na kliknięcie slotu i elementu) oraz `node_modules/@open-mercato/ui/src/backend/schedule/*` (kontrakt `ScheduleView`, `ScheduleToolbar`, `ScheduleItem`, `getScheduleItemStyle`). Reguły z `.ai/guides/backend-ui.md` obowiązują w całości; implementacja wchodzi przez `om-backend-ui-design`.

Odwołania do rekordów działają jak w VIS: każde pole referencji to kontrolka wyboru na źródle opcji właściciela, tabele i kafle pokazują nazwy albo snapshoty, UUID żyją wyłącznie w payloadach.

**Makiety do przeglądu (2026-09-30).** Źródło: [`assets/vcal-ui-mockups.html`](assets/vcal-ui-mockups.html), render: `node .ai/specs/assets/render-vcal-mockups.mjs`.

| # | Ekran | Co pokazuje |
|---|---|---|
| 01 | [Kalendarz wizyt — tydzień terapeuty](assets/vcal-ui-01-kalendarz-wizyt-tydzien-terapeuty.png) | Siatka tygodnia, pasma godzin pracy i nieobecności, podwójna rezerwacja obok siebie, wizyta o nieznanym czasie trwania, legenda |
| 02 | [Nowa wizyta z wolnego slotu](assets/vcal-ui-02-nowa-wizyta-z-wolnego-slotu-termin-wolny.png) | Slot wskazany kliknięciem, dialog z wypełnionym terminem, wynik „termin wolny” |
| 03 | [Ostrzeżenia](assets/vcal-ui-03-ostrzezenia-podwojna-rezerwacja-i-gabinet-poza-g.png) | `member_double_booked` + `resource_outside_availability`, przycisk „Zapisz mimo ostrzeżeń” |
| 04 | [Nadpisanie z powodem](assets/vcal-ui-04-nadpisanie-ostrzezen-wymagany-powod-i-potwierdze.png) | Potwierdzenie konkretnych sygnatur, wymagany powód, informacja o unieważnieniu zgody |
| 05 | [Odmowa — nieobecność](assets/vcal-ui-05-odmowa-nieobecnosc-wykonawcy-blokuje-zapis.png) | `member_absence`, wyłączony zapis, ścieżka naprawy przez moduł kadrowy, wariant bez `staff.view` |
| 06 | [To samo sprawdzenie z listy](assets/vcal-ui-06-to-samo-sprawdzenie-w-formularzu-z-listy-wizyt.png) | Ten sam blok w formularzu VIS — dowód, że kontrola nie mieszka w kalendarzu |
| 07 | [Miesiąc i kalendarz gabinetu](assets/vcal-ui-07-widok-miesiaca-i-kalendarz-gabinetu.png) | Filtr zasobu, dni niedostępności gabinetu, zwijanie „+N więcej” |
| 08 | [Karta wizyty ze znacznikiem](assets/vcal-ui-08-karta-wizyty-znacznik-zapisu-mimo-ostrzezen.png) | Kto, kiedy, jakie kody, gdzie mieszka powód |
| 09 | [Lista wizyt z przełącznikiem](assets/vcal-ui-09-lista-wizyt-przelacznik-lista-kalendarz.png) | Lista/Kalendarz, „Pokaż w kalendarzu”, kolumna „Sprawdzenie” |
| 10 | [Stany UI](assets/vcal-ui-10-stany-ui-wymagane-na-kazdej-powierzchni.png) | loading, empty, error, degradacja, brak uprawnienia, 409, sprawdzanie, brak grafiku |
| 11 | [Szerokość 360 px](assets/vcal-ui-11-szerokosc-360-px-kalendarz-sprawdzenie-i-nadpisa.png) | Widok dnia, blok ostrzeżeń, nadpisanie i odmowa na wąskim ekranie, opisy dla czytnika ekranu |

Makiety są dokumentem projektowym, nie implementacją: wygląd docelowy powstaje z `ScheduleView` i tokenów design systemu, a nie z tego HTML-a.

| Powierzchnia / trasa | Cel i akcje | Źródło / mutacje | Najbliższa referencja | Komponenty | Wymagane stany | Wymagania |
|---|---|---|---|---|---|---|
| `/backend/patient/visits/calendar` | Siatka wizyt dzień/tydzień/miesiąc/agenda; filtr terapeuty, gabinetu, statusu; slot → nowa wizyta; kafel → edycja; przełącznik Lista/Kalendarz | `GET /api/patient/visits/calendar`; mutacje przez istniejące komendy VIS | `customers/backend/calendar/page.tsx`, `planner/components/AvailabilitySchedule.tsx` | `Page`, `PageBody`, `ScheduleView`, `FilterBar`, `Dialog`, `CrudForm`, `StatusBadge`, `Alert`, `EmptyState` | loading, empty, error/retry, brak uprawnień, konflikt 409, degradacja, sukces | R01, R02, R03, R07 |
| `/backend/patient/visits` (VIS) | Dodany przełącznik Lista/Kalendarz i odnośnik „Pokaż w kalendarzu” w akcjach wiersza | bez zmian | `example/components/TodosTable.tsx` | `DataTable`, `RowActions`, `SegmentedControl` | jak w VIS | R01, R03 |
| Dialog wizyty w kalendarzu | Ten sam `CrudForm` co create/edit VIS, w oknie dialogowym, z terminem z klikniętego slotu | `POST`/`PUT /api/patient/visits` | `planner/components/AvailabilitySchedule.tsx` (wzorzec dialogu nad siatką) | `Dialog`, `CrudForm`, `FormField` | walidacja, konflikt, sukces, 409, blokada podwójnego zapisu | R02, R04, R05 |
| Blok sprawdzenia dostępności | Ostrzeżenia i odmowy pod polami terminu; jeden komponent w dialogu i w formularzu z listy | `GET /api/patient/visits/availability-check` (debounce), potem serwer przy zapisie | `customers/lib/calendar/conflicts.ts` (zasada spójności edytora z siatką) | `Alert`, `StatusBadge`, `LoadingMessage` | sprawdzanie, wolne, ostrzeżenia, odmowa, nieznane | R04, R05, R07 |
| Dialog nadpisania | Lista ostrzeżeń, wymagany powód, potwierdzenie | `POST`/`PUT` z `conflictOverride` | `patient` dialogi powodów VIS (cancel/no-show/reopen) | `Dialog`, `FormField`, `Alert` | walidacja powodu, brak uprawnienia, błąd, sukces | R06 |
| `/backend/patient/visits/[id]` (VIS) | Znacznik „Zapisana mimo ostrzeżeń” z powodem, autorem i czasem | `GET` szczegółu | Karta wizyty VIS | `SectionHeader`, `StatusBadge`, `Alert` | brak nadpisania, nadpisanie, brak uprawnienia do powodu | R06 |

### UI architecture

| Rola | Grupy nawigacji w kolejności | Widgety | Droga od logowania do zadania |
|---|---|---|---|
| Rejestracja / planista | Opieka → Pacjenci; Opieka → Wizyty; Opieka → Kalendarz wizyt | brak nowych | Logowanie → Kalendarz wizyt → klik w slot → zapis (3 kliknięcia) |
| Koordynator grafiku | jw. | brak nowych | Logowanie → Kalendarz wizyt → wybór terapeuty (2 kliknięcia) |

Pozycja „Kalendarz wizyt” mieszka w grupie „Opieka”, tuż za „Wizyty”, z `pagePriority`/`pageOrder` stawiającym ją po liście, ikoną `calendar` z zainstalowanego rejestru ikon i widocznością pod `patient.visits.view`. Dialogi i strona szczegółu pozostają poza nawigacją.

| Powierzchnia | Pusty stan | Zachowanie responsywne | Klawiatura i fokus |
|---|---|---|---|
| Kalendarz | „Brak wizyt w tym zakresie” + akcja „Zaplanuj wizytę” i podpowiedź zmiany zakresu | ≤768 px: domyślnie widok dnia i agendy, pasek filtrów zwija się do przycisku „Filtruj”, siatka przewija się poziomo bez utraty kontrolek | Tab po kolejnych kaflach, Enter otwiera, Escape zamyka dialog, Cmd/Ctrl+Enter zapisuje; zmiana zakresu ogłaszana przez `aria-live` |
| Blok sprawdzenia | Przed wyborem terminu: „Wybierz wykonawcę i termin, aby sprawdzić dostępność” | Pełna szerokość pod polami terminu, bez skracania tekstu ostrzeżeń | Zmiana wyniku ogłaszana `aria-live="polite"`; odmowa ustawia fokus na pierwszym błędnym polu |
| Dialog nadpisania | — | 360 px: lista ostrzeżeń przewijana, przyciski w stopce pełnej szerokości | Fokus startuje na polu powodu i wraca do przycisku zapisu po zamknięciu |

### `/backend/patient/visits/calendar` — Kalendarz wizyt

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Kalendarz wizyt                          [ Lista | Kalendarz ] [+ Wizyta]│
│ [Terapeuta ▼ Anna Nowicka] [Gabinet ▼ Wszystkie] [Status ▼ Zaplanowane] │
├─────────────────────────────────────────────────────────────────────────┤
│ [‹] [›] [28 wrz – 4 paź 2026]        [Dzień|Tydzień|Miesiąc|Agenda] [TZ]│
├─────────────────────────────────────────────────────────────────────────┤
│       PON 28   WT 29    ŚR 30    CZW 1    PT 2                          │
│ 08:00 ░░░░░░   ░░░░░░   ░░░░░░   ▓▓▓▓▓▓   ░░░░░░   ░ godziny pracy      │
│ 09:00 ░░░░░░   ▌Wizyta  ░░░░░░   ▓▓▓▓▓▓   ░░░░░░   ▓ urlop (blokuje)    │
│ 10:00 ▌Wizyta  ░░░░░░   ▌Wizyta  ▓▓▓▓▓▓   ░░░░░░   ▌ wizyta, kolor=status│
│ 11:00 ░░░░░░   ░░░░░░   ░░░░░░   ▓▓▓▓▓▓   ▚ ▌2 wizyty — podwójna rez.   │
├─────────────────────────────────────────────────────────────────────────┤
│ Pokazano 14 wizyt · kontrola dostępności aktywna                        │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Zachowanie:** zmiana zakresu, widoku i filtrów zapisuje się w adresie (`from`, `to`, `view`, `teamMemberId`, `resourceId`, `status`), więc widok terapeuty jest odnośnikiem do wysłania. Każda zmiana zakresu to jedno żądanie; wynik jest cache'owany po kluczu zakresu i filtrów. Zakres szerszy niż 62 dni odmawia i proponuje widok miesiąca — chroni przed pobraniem roku wizyt jednym żądaniem. Kliknięcie slotu otwiera dialog tylko przy `patient.visits.manage`; bez niego siatka jest czytelna i nieklikalna w pustych miejscach. Usunięcie i zmiana statusu odbywają się w dialogu wizyty przez akcje VIS z ich dialogami powodów. Konflikt wersji przy zapisie zachowuje treść dialogu.
- **Responsywność i dostępność:** kafel ma dostępną nazwę „godzina, pacjent, wykonawca, status”; pasma tła są dekoracją z `aria-hidden` i mają odpowiednik tekstowy w agendzie; kontrola widoku to `SegmentedControl` obsługiwany strzałkami; wszystkie kontrolki ikonowe mają etykiety.
- **Lokalizacja:** przestrzeń `patient.visits.calendar.*` i `patient.visits.conflicts.*` w `pl` i `en`; kody konfliktów są stabilnymi identyfikatorami i nigdy nie są tłumaczone w payloadzie — tłumaczy się wyłącznie ich prezentacja. Nazwy dni, miesięcy i pierwszy dzień tygodnia pochodzą z lokalizacji `ScheduleCalendar`; strefa czasowa jest jawna w pasku i w wizycie.
- **Design system i motywy:** kolory kafli z `getScheduleItemStyle` na tokenach `--status-*`; pasma tła na `--muted` i `--border`; status wizyty przez `StatusBadge`. Zero wartości kolorów w kodzie aplikacji, zero ręcznych łatek `dark:`, sprawdzone w obu motywach i przy `prefers-reduced-motion`.

### Blok sprawdzenia dostępności (dialog kalendarza i formularz z listy)

```text
┌──────────────────────────────────────────────────────────────┐
│ ⚠ Sprawdzenie dostępności                                    │
│ • Anna Nowicka ma inną wizytę 10:30–11:30       [ostrzeżenie]│
│ • Gabinet 2 poza godzinami dostępności           [ostrzeżenie]│
│ Zapis wymaga potwierdzenia i podania powodu.                 │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│ ⛔ Nie można zapisać                                          │
│ • Anna Nowicka jest nieobecna 5–9 paź (wniosek zaakceptowany)│
│ Wybierz inny termin lub wykonawcę. Jeśli nieobecność jest    │
│ nieaktualna, skoryguj wniosek w module kadrowym.  [Otwórz →] │
└──────────────────────────────────────────────────────────────┘
```

Odnośnik do wniosku pojawia się wyłącznie przy `staff.leave_requests.manage`. Bez `staff.view` wiersz brzmi „Anna Nowicka jest niedostępna 5–9 paź” — bez słowa o powodzie.

## Data Models

VCAL nie dodaje encji. Rozszerza `PatientVisit` (VIS, tabela `patient_visits`, entity ID `patient:patient_visit`) o cztery pola audytu nadpisania i o dwa indeksy wspierające wykrywanie nakładania.

### `PatientVisit` — pola dodane przez VCAL

| Pole | Typ / nullowalność | Zakres / indeks | Wrażliwe / szyfrowane | Cykl życia i walidacja |
|---|---|---|---|---|
| `conflict_override_reason` | text, nullable | bez indeksu treści | **tak** — mapa szyfrowania `patient/encryption.ts` | 1–2000 znaków; wymagane, gdy pozostałe pola nadpisania są ustawione |
| `conflict_override_at` | timestamptz, nullable | — | nie | Ustawiane serwerowo w chwili zapisu z nadpisaniem |
| `conflict_override_by_user_id` | uuid, nullable | — | nie | Skalarne ID z auth; nigdy z payloadu |
| `conflict_override_codes` | jsonb, nullable | GIN opcjonalnie, tylko do raportowania | nie | Tablica kodów z macierzy konfliktów; wyłącznie wartości ze słownika, bez wolnego tekstu i bez nazw osób |

`CHECK`: wszystkie cztery pola `NULL` albo wszystkie cztery ustawione, przy czym `conflict_override_codes` jest niepustą tablicą. Pola nie są edytowalne przez generyczne `PUT` — wchodzą wyłącznie przez komendę, po wykryciu ostrzeżeń, jak `confirmed_*` i `settled_*` w VIS. Zapis bez ostrzeżeń zeruje cały komplet.

### Indeksy wykrywania nakładania

VIS ma już `scope + team_member_id + starts_at` i `scope + resource_id + starts_at`. VCAL dokłada dwa indeksy częściowe, które ograniczają skan do rekordów mogących zajmować czas:

```sql
CREATE INDEX patient_visits_member_busy_idx
  ON patient_visits (tenant_id, organization_id, team_member_id, starts_at, ends_at)
  WHERE deleted_at IS NULL AND status <> 'cancelled';

CREATE INDEX patient_visits_resource_busy_idx
  ON patient_visits (tenant_id, organization_id, resource_id, starts_at, ends_at)
  WHERE deleted_at IS NULL AND status <> 'cancelled' AND resource_id IS NOT NULL;
```

Zapytanie nakładania jest półotwarte i zawsze ograniczone zakresem: `starts_at < :end AND (ends_at > :start OR (ends_at IS NULL AND starts_at >= :start))`, w obrębie tenant/organizacja, z pominięciem `:excludeVisitId`.

### Encje czytane, nigdy zapisywane

`planner_availability_rules` (po `tenant_id`, `organization_id`, `subject_type`, `subject_id`, `deleted_at IS NULL`), `planner_availability_rule_sets` (pośrednio przez `subject_type='ruleset'`) oraz `resources_resources` (`id`, `is_active`, `deleted_at`, `availability_rule_set_id`, `name`). Odczyt jest skalarny po identyfikatorach i zawsze zawężony zakresem — bez dekoratora relacji, bez klucza obcego i bez kaskady. Usunięcie reguły, zasobu albo członka zespołu nie dotyka wizyt; VIS już trzyma snapshoty nazw, więc historia pozostaje czytelna.

Migracja obejmuje wyłącznie cztery kolumny, `CHECK` i dwa indeksy na tabeli utworzonej w VIS-1. `yarn db:generate`, przegląd SQL i snapshotu, zgoda przed `apply`. Migracji nie uruchamiamy w celu walidacji.

## API, Command, and Error Contracts

Każdy plik trasy eksportuje `metadata` per metoda i `openApi`; scope pochodzi z serwera, nigdy z payloadu.

| Metoda | Ścieżka / komenda | Auth i feature | Wejście | Sukces / zdarzenie | Błędy i współbieżność | Wymagania |
|---|---|---|---|---|---|---|
| `GET` | `/api/patient/visits/calendar` | auth + `patient.visits.view` + `patient.patients.view` | `from`, `to` (ISO z offsetem, zakres ≤62 dni), `teamMemberId?`, `resourceId?`, `patientId?`, `status?` | `{ items: CalendarVisit[], lanes: AvailabilityLane[], degraded: DegradationNote[] }` | 400 zły/za szeroki zakres; 401; 403; 503 tylko dla twardej awarii własnej bazy | R01, R03, R07 |
| `GET` | `/api/patient/visits/availability-check` | auth + `patient.visits.manage` | `teamMemberId`, `startsAt`, `endsAt?`, `resourceId?`, `excludeVisitId?` | `{ conflicts: Conflict[], worstSeverity, checkedAt }` | 400 schema/strefa; 401; 403; 422 nieaktywna referencja | R04, R05, R07 |
| `POST` | `/api/patient/visits` (VIS, rozszerzone) | auth + `patient.visits.manage` (+ `override_conflict` przy nadpisaniu) | VIS + opcjonalne `conflictOverride: { acknowledgedSignatures: string[], reason: string }` | 201 + `patient.visit.created` (+ `patient.visit.conflict_overridden`) | 422 `visit_conflict_blocking` / `visit_conflict_unacknowledged` z `conflicts[]`; 403 brak uprawnienia do nadpisania; pozostałe jak VIS | R04, R05, R06 |
| `PUT` | `/api/patient/visits` (VIS, rozszerzone) | jw. | VIS + `expectedUpdatedAt` + opcjonalne `conflictOverride` | 200 nowa wersja + `patient.visit.updated` (+ `conflict_overridden`) | 409 stara wersja (bez zmian); 422 jak wyżej; 403 | R04, R05, R06 |

**Kształt konfliktu.** `{ code, severity: 'blocking'|'warning'|'info', subjectType: 'member'|'resource', subjectId, subjectName, from, to, reasonLabel?, conflictingVisitId?, signature }`. `subjectName` to nazwa z hosta lub snapshot VIS — nigdy UUID w prezentacji. `reasonLabel` pojawia się tylko przy `staff.view`/`resources.view`. `signature` to skrót `code|subjectType|subjectId|from|to` zaokrąglony do minuty; jest nieprzezroczysty dla klienta i służy wyłącznie potwierdzeniu.

**Kontrakt nadpisania.** `acknowledgedSignatures` musi pokrywać **dokładnie** zbiór ostrzeżeń policzony serwerowo w chwili zapisu. Brak którejkolwiek sygnatury, sygnatura nadmiarowa albo zmiana sytuacji między podglądem a zapisem kończy się 422 `visit_conflict_unacknowledged` z aktualną listą — operator widzi to, na co faktycznie się zgadza. `reason` jest wymagany i niepusty. Konflikty `blocking` nie dają się potwierdzić w żadnym trybie. Konflikty `info` nigdy nie wymagają sygnatury.

**Odmowa.** `422 visit_conflict_blocking` niesie `{ error: 'visit_conflict_blocking', conflicts: [...] }`. Jest to ten sam kod rodziny, którego VIS używa dla nieaktywnej referencji i niedozwolonego czasu, więc klasa błędu pozostaje spójna; `409` pozostaje zarezerwowane wyłącznie dla konfliktu wersji, żeby obie sytuacje dały się rozróżnić bez czytania treści.

**Idempotencja.** `clientRequestId` z VIS działa bez zmian; powtórzenie tego samego create z tym samym `conflictOverride` zwraca ten sam rekord, a nie drugą wizytę ani drugie nadpisanie.

**OpenAPI.** Obie nowe trasy publikują schematy wejścia i wyjścia, w tym słownik kodów konfliktów jako `enum` — kody są kontraktem publicznym i podlegają `.ai/guides/upstream/BACKWARD_COMPATIBILITY.md`; dodanie kodu jest zmianą addytywną, zmiana znaczenia lub wagi istniejącego wymaga ścieżki deprecjacji.

## Events, Jobs, Notifications, and Cross-Module Flows

| Wyzwalacz | Producent | Konsument | Skutek | Ponowienia / idempotencja / audyt |
|---|---|---|---|---|
| `patient.visit.conflict_overridden` | `patient` | audyt, indeks | Rejestracja świadomego nadpisania | Emitowane wyłącznie po skutecznym commit, raz na zapis; payload `{ id, patientId, tenantId, organizationId, codes[], updatedAt }` |
| `patient.visit.created` / `.updated` | `patient` (VIS) | jw. | Bez zmian | Nadpisanie nie mnoży zdarzeń VIS |

Payload zdarzenia nie zawiera powodu nadpisania, nazwisk, opisu wizyty ani nazw reguł — wyłącznie identyfikatory i kody ze słownika, zgodnie z regułą VIS. Odbiorca zdarzenia nie uzyskuje przez nie prawa do danych.

VCAL nie dodaje zadań w tle, workerów, harmonogramów ani powiadomień. Nie subskrybuje zdarzeń `staff` ani `planner`: zmiana urlopu **nie** przelicza wstecz istniejących wizyt. Taka wsteczna rewizja to osobna zdolność (raport „wizyty kolidujące z nowo zaakceptowanym urlopem”) i świadomie zostaje poza zakresem — VCAL sprawdza w chwili zapisu, a kalendarz i tak pokaże nałożenie przy najbliższym otwarciu. Unieważnienia cache i efekty indeksujące zostają jak w VIS, po commicie.

## Security, Privacy, and Compliance

- **Autoryzacja:** wyłącznie feature IDs, nigdy nazwy ról. Kalendarz wymaga `patient.visits.view` i `patient.patients.view`; sprawdzenie i zapis `patient.visits.manage`; nadpisanie dodatkowo `patient.visits.override_conflict`. Widoczność kontrolki nigdy nie zastępuje kontroli serwerowej — każdą z nich egzekwuje trasa i komenda.
- **Izolacja tenantów:** wszystkie odczyty — wizyt, reguł `planner` i zasobów — są zawężone wyprowadzonym `tenantId` i `organizationId`. Brak albo niezgodność zakresu odrzuca żądanie; zakres nigdy nie pochodzi z payloadu. Obce ID w filtrze kalendarza zwraca pusty wynik, nie błąd ujawniający istnienie rekordu.
- **Dane wrażliwe:** `conflict_override_reason` jest szyfrowany i nieindeksowany, jak pozostałe wolne teksty PAT. Powód nieobecności (`unavailability_reason_value`) to dana kadrowa: nie jest kopiowany do `patient`, nie trafia do zdarzeń, logów ani do odpowiedzi użytkownikowi bez `staff.view`. Kalendarz nie ujawnia danych klinicznych — kafel niesie godzinę, nazwisko, wykonawcę, gabinet i status.
- **Enumeracja:** `availability-check` mógłby posłużyć do odpytywania grafików personelu. Dlatego wymaga `patient.visits.manage`, zwraca wyłącznie okna nakładające się na *podany termin* (nie cały grafik), nie ujawnia powodu bez `staff.view` i nie potwierdza istnienia podmiotu spoza zakresu.
- **Współbieżność:** dwa równoległe zapisy w ten sam slot to realny przypadek dwóch rejestratorek. Przeliczenie konfliktów następuje **po** zajęciu blokady i sprawdzeniu `expectedUpdatedAt`, wewnątrz tej samej transakcji, więc drugi zapis widzi pierwszy. Dla nowej wizyty blokowany jest pacjent (kolejność `patient → visit` z VIS), co porządkuje też tworzenie i utrzymuje jeden porządek blokad, bez ryzyka zakleszczenia.
- **Fail closed kontra degradacja:** zakres i uprawnienia zawodzą zamknięcie. Sam odczyt dostępności, jako kontrola operacyjna, degraduje się jawnie — awaria `planner` nie może zatrzymać rejestracji, ale nie wolno jej udawać sprawdzenia, które się nie odbyło. Ta różnica jest zamierzona i testowana.
- **Logi:** kody konfliktów i identyfikatory tak, powody i nazwiska nie.

## Integration Coverage

Pliki `src/modules/patient/__integration__/VCAL-Txx.spec.ts`. Każdy tworzy własnych pacjentów, członków zespołu, zasoby, reguły dostępności i granty w dwóch zakresach przez wspierane fixtures i API; żaden nie zależy od danych Polany ani od produkcji.

| Test | Poziom | Fixture | Działania | Asercje | Wymagania |
|---|---|---|---|---|---|
| VCAL-T01 | integration | Terapeuta z regułą tygodniową, wizyty w zakresie i poza nim | `GET /calendar` dla dnia, tygodnia, miesiąca; filtry terapeuty/gabinetu/statusu; zakres 63 dni | Zwracane tylko wizyty z zakresu i scope; pasma zgodne ze scaleniem `plannerAvailabilityService`; zakres ponad limit odrzucony 400 | R01, R03 |
| VCAL-T02 | integration | Wniosek urlopowy zaakceptowany przez API `staff` | Zapis wizyty w oknie urlopu z kalendarza i z listy; potem z `conflictOverride` | 422 `visit_conflict_blocking` w obu ścieżkach, identyczny kod; nadpisanie też odrzucone; zero zapisów | R04, R06 |
| VCAL-T03 | integration | Wniosek `pending`, wniosek odrzucony, ręczna reguła `unavailability` | Zapis w każdym z tych okien | `pending` i odrzucony nie blokują i nie ostrzegają; ręczna reguła ostrzega jako `member_unavailable` | R04 |
| VCAL-T04 | integration | Dwie wizyty tego samego terapeuty; wizyty stykające się końcami; wizyta bez `ends_at`; wizyta anulowana | Zapisy w nakładających się i stykających terminach | `member_double_booked` tylko przy faktycznym nachodzeniu; styk końców nie koliduje; brak `ends_at` traktowany jako chwila; anulowana nie zajmuje | R04 |
| VCAL-T05 | integration | Gabinet aktywny z regułami, gabinet nieaktywny, gabinet zajęty, zestaw reguł przez `availability_rule_set_id` | Zapisy z każdym z nich | `resource_inactive` blokuje; `resource_unavailable`, `resource_outside_availability`, `resource_double_booked` ostrzegają; reguły zestawu uwzględnione | R05 |
| VCAL-T06 | integration | Rola z `visits.manage` bez `override_conflict` i rola z nim | Zapis z ostrzeżeniem bez zgody, z niekompletnymi sygnaturami, z pustym powodem, z kompletem; zmiana sytuacji między podglądem a zapisem | Kolejno 422 `unacknowledged`, 422, 422, sukces z `conflict_override_*`; bez feature 403; nieaktualne sygnatury 422 z nową listą; kolejny czysty zapis zeruje pola | R06 |
| VCAL-T07 | security | Druga organizacja i drugi tenant; obce ID terapeuty/gabinetu/wizyty; brak feature; użytkownik bez `staff.view` | Odczyt kalendarza i `availability-check`, próby zapisu | Fail closed, brak wycieku istnienia rekordów; bez `staff.view` brak `reasonLabel`; brak powodów i nazwisk w logach i zdarzeniach | R08 |
| VCAL-T08 | UI | Wizyty, reguły, uprawnienia i degradacja | Kalendarz w dzień/tydzień/miesiąc/agenda, klik slotu i kafla, zapis, ostrzeżenie, nadpisanie, odmowa; loading/empty/error/409/brak uprawnień; klawiatura; 360 px; oba motywy | Pełny przepływ bez UUID i bez surowych kontrolek; ten sam blok ostrzeżeń w dialogu i w formularzu listy; odmowa wyłącza zapis; stany i lokalizacja kompletne | R01, R02, R03, R06, R07 |
| VCAL-T09 | integration | `planner` wyłączony w rejestrze modułów; wymuszony błąd odczytu reguł | Kalendarz i zapis w obu sytuacjach | Praca nie staje; `availability_unknown` obecne w odpowiedzi i widoczne w UI; podwójna rezerwacja nadal wykrywana; nieaktywny gabinet nadal blokuje | R07 |
| VCAL-T10 | integration | Dwa równoległe zapisy w ten sam slot i w tę samą wizytę | Równoległe create i update | Drugi zapis widzi pierwszy: ostrzeżenie albo 409 wersji; brak dwóch wizyt z jednego `clientRequestId`; brak zapisu częściowego | R04, R08 |

Do tego testy jednostkowe czystej funkcji `evaluateVisitConflicts`: granice półotwarte, `ends_at IS NULL`, styk końców, zmiana czasu letniego w `Europe/Warsaw` (godzina nieistniejąca i podwójna), pusty grafik, wiele nakładających się okien oraz stabilność sygnatury przy zaokrąglaniu do minuty.

## Implementation Phases

### VCAL-1 — Kontrola dostępności na ścieżce zapisu

- **Depends on:** VIS-1 exit gate (tabela wizyt, komendy, lista i formularz) oraz zatwierdzenie tej specyfikacji. Nie czeka na VIS-2 ani na kalendarz.
- **Outcome / wartość:** od tej fazy żaden zapis wizyty — z listy czy przez API — nie przechodzi po cichu mimo nieobecności wykonawcy lub niedostępnego gabinetu. Wartość jest dostarczona bez jednej linii kodu kalendarza.
- **Deliverables:** `patient/lib/availability.ts` (`patientAvailabilityService`, rejestracja w `patient/di.ts`, rozpoznanie obecności modułów); `patient/lib/visitConflicts.ts` (`evaluateVisitConflicts`, sygnatury, macierz wag); cztery pola nadpisania, `CHECK`, dwa indeksy częściowe, mapa szyfrowania i migracja; feature `patient.visits.override_conflict` w `acl.ts` i `setup.ts`; rozszerzenie komend `patient.visits.create/update`; trasa `GET /api/patient/visits/availability-check` z `metadata` i `openApi`; zdarzenie `patient.visit.conflict_overridden`; blok ostrzeżeń i dialog nadpisania w formularzu wizyty VIS; katalogi `pl`/`en`.
- **Niezależne wycinki:** (a) serwis odczytu + funkcja konfliktów z testami jednostkowymi; (b) model, migracja, ACL; (c) komendy i trasa; (d) UI ostrzeżeń. (a) i (b) mogą iść równolegle; (c) czeka na obie; (d) na (c). Nie edytować `data/entities.ts` ani `acl.ts` w dwóch zadaniach naraz.
- **Requirements closed:** R04, R05, R06, R07 (ścieżka zapisu), R08.
- **Tests:** VCAL-T02, T03, T04, T05, T06, T07, T09, T10 + testy jednostkowe konfliktów.
- **Validation:** `yarn db:generate` i przegląd scoped SQL/snapshotu (bez `apply` bez zgody); `yarn generate`; `yarn typecheck`; `yarn test` dla nowych testów jednostkowych; `yarn test:integration:ephemeral` dla wskazanych VCAL-T w zatwierdzonym środowisku. Nigdy nie migrujemy w celu walidacji.
- **Exit gate:** zaakceptowany urlop blokuje zapis z listy i przez API tym samym kodem; ostrzeżenie bez kompletu sygnatur i bez powodu nie zapisuje; nadpisanie zostawia powód, autora, czas i kody; brak `override_conflict` daje 403; wyłączony `planner` nie zatrzymuje pracy i jest widoczny; formularz z listy pokazuje ostrzeżenia w obu motywach, na 360 px i z klawiatury.

### VCAL-2 — Widok kalendarza i kalendarz terapeuty

- **Depends on:** VCAL-1 exit gate.
- **Outcome / wartość:** planista pracuje w siatce: widzi tydzień wybranego terapeuty razem z jego grafikiem i nieobecnościami, zakłada wizytę kliknięciem w wolny slot i otwiera istniejącą kliknięciem w kafel — z tą samą kontrolą, którą VCAL-1 już egzekwuje.
- **Deliverables:** `GET /api/patient/visits/calendar` (pozycje, pasma, noty degradacji, limit zakresu) z `metadata` i `openApi`; strona `backend/patient/visits/calendar/page.tsx` + `page.meta.ts` z nawigacją w grupie „Opieka”; `components/VisitsCalendar.tsx` na `ScheduleView` z paskiem filtrów i stanem w adresie; dialog wizyty ponownie używający `CrudForm` VIS; przełącznik Lista/Kalendarz i akcja „Pokaż w kalendarzu” na liście VIS; znacznik nadpisania na karcie wizyty; katalogi `pl`/`en`; `yarn generate` po zmianie stron.
- **Niezależne wycinki:** (a) trasa kalendarza z testem integracyjnym; (b) komponent siatki i filtrów; (c) dialog i wejścia z listy. (a) i (b) równolegle; (c) po obu.
- **Requirements closed:** R01, R02, R03 i domknięcie R07 na powierzchni kalendarza.
- **Tests:** VCAL-T01, T08 + regresja VCAL-T02/T06 przez ścieżkę kalendarza i VIS-T08.
- **Validation:** `yarn generate && yarn typecheck && yarn lint && yarn ds:check && yarn test && yarn build`; `yarn test:integration:ephemeral` dla VCAL-T01/T08 i wskazanej regresji.
- **Exit gate:** cztery widoki działają i zachowują zakres w adresie; odnośnik do kalendarza terapeuty otwiera ten sam widok u innego użytkownika z jego uprawnieniami; slot zakłada wizytę, kafel ją otwiera; wizyta zapisana mimo ostrzeżeń jest oznaczona; komplet stanów, klawiatura, 360 px i oba motywy sprawdzone; `ds:check` bez wyjątków.

Żadna z faz nie jest workiem „integracja i poprawki” — obie kończą się działającym, sprawdzalnym przepływem.

## Requirement Traceability

| Wymaganie | Journey / powierzchnia | Kontrakty | Faza | Testy | Kryterium |
|---|---|---|---|---|---|
| VCAL-R01 | J1, `/visits/calendar` | `GET /calendar` | 2 | T01, T08 | VCAL-AC01 |
| VCAL-R02 | J1, dialog slotu i kafla | `POST`/`PUT /visits` | 2 | T08 | VCAL-AC02 |
| VCAL-R03 | J1, J4, filtr terapeuty i gabinetu | `GET /calendar` + pasma | 2 | T01, T08 | VCAL-AC03 |
| VCAL-R04 | J2, J3, J5 | `availability-check`, komendy | 1 | T02, T03, T04, T10 | VCAL-AC04 |
| VCAL-R05 | J4 | `availability-check`, komendy | 1 | T05 | VCAL-AC05 |
| VCAL-R06 | J2 | `conflictOverride`, `conflict_override_*`, zdarzenie | 1 | T06, T08 | VCAL-AC06 |
| VCAL-R07 | J6 | `degraded[]`, `availability_unknown` | 1 / 2 | T09, T08 | VCAL-AC07 |
| VCAL-R08 | wszystkie | ACL, scope, blokady, szyfrowanie | 1 | T07, T10 | VCAL-AC08 |

Klasyfikacja mechanizmów według `src/modules/example/references/surface-inventory.json`; każdy wzorzec wskazuje dokładny plik, a testy w wierszach są samowystarczalne.

| Powierzchnia | Wymaganie | Capability ID | Wzorzec | Faza | Oracle | Klasyfikacja |
|---|---|---|---|---|---|---|
| Pola nadpisania w encji wizyty | R06 | data.entities | `src/modules/example/data/entities.ts` | 1 | VCAL-T06 | emitted-example |
| Migracja pól i indeksów | R06 | data.migrations | `src/modules/example/migrations/Migration20260804120546_example.ts` | 1 | VCAL-T06 | emitted-example |
| Walidatory wejścia sprawdzenia i nadpisania | R04/R05/R06 | data.validators | `src/modules/example/data/validators.ts` | 1 | VCAL-T02/T06 | emitted-example |
| Szyfrowanie powodu nadpisania | R08 | data.encryption-map | `src/modules/example/encryption.ts` | 1 | VCAL-T07 | emitted-example |
| Feature `override_conflict` + rola startowa | R06/R08 | module.acl-features; module.setup-role-features | `src/modules/example/acl.ts`; `src/modules/example/setup.ts` | 1 | VCAL-T06/T07 | emitted-example |
| Rozszerzone komendy zapisu wizyty | R04/R05/R06 | commands.write | `src/modules/example/commands/todos.ts` | 1 | VCAL-T02/T04/T06/T10 | emitted-example |
| `patientAvailabilityService` w kontenerze | R04/R05/R07 | module.di-registration | `src/modules/example/di.ts` | 1 | VCAL-T09 | emitted-example |
| `GET /availability-check` | R04/R05 | api.custom-route | `src/modules/example/api/organizations/route.ts` | 1 | VCAL-T03/T05 | emitted-example |
| `GET /calendar` | R01/R03 | api.custom-route | `src/modules/example/api/organizations/route.ts` | 2 | VCAL-T01 | emitted-example |
| Schematy OpenAPI obu tras | R08 | api.openapi | `src/modules/example/api/openapi.ts` | 1/2 | VCAL-T07 | emitted-example |
| Zdarzenie `conflict_overridden` | R06 | events.typed-definitions | `src/modules/example/events.ts` | 1 | VCAL-T06 | emitted-example |
| Strona kalendarza i jej nawigacja | R01 | ui.page-shell | `src/modules/example/backend/todos/page.meta.ts` | 2 | VCAL-T08 | emitted-example |
| Siatka wizyt i filtry | R01/R03 | ui.datatable | `src/modules/example/components/TodosTable.tsx` | 2 | VCAL-T08 | emitted-example |
| Dialog wizyty ze slotu | R02 | ui.form-create | `src/modules/example/components/TodoForm.tsx` | 2 | VCAL-T08 | emitted-example |
| Blok ostrzeżeń i dialog nadpisania | R04/R05/R06 | ui.form-edit | `src/modules/example/backend/todos/[id]/edit/page.tsx` | 1 | VCAL-T08 | emitted-example |
| Katalogi `pl`/`en` | R01–R07 | module.i18n-catalogs | `src/modules/example/i18n/pl.json` | 1/2 | VCAL-T08 | emitted-example |

## Rollout, Migration, and Rollback

Kolejność: VIS-1 → VCAL-1 → VCAL-2. VCAL-1 wprowadza migrację czterech kolumn, `CHECK` i dwóch indeksów częściowych na tabeli `patient_visits`; `yarn db:generate`, przegląd scoped SQL i snapshotu, zgoda przed zastosowaniem. Nie ma backfillu — istniejące wizyty mają komplet pól nadpisania `NULL`, co znaczy „zapisana bez ostrzeżeń”, i to jest prawda o rekordach sprzed VCAL. Indeksy zakładane na małej tabeli świeżo po VIS-1; przy większym wolumenie `CREATE INDEX CONCURRENTLY` poza transakcją migracji.

`patient.visits.override_conflict` nie trafia domyślnie do roli rejestracji — organizacja przyznaje go świadomie. Do czasu przyznania ostrzeżenia są widoczne, a zapis mimo nich nie jest możliwy; to bezpieczniejszy stan startowy niż milczące uprawnienie.

Wyłączenie modułu `planner` jest wspieranym stanem, nie awarią: kontrola dostępności milknie, wykrywanie podwójnej rezerwacji działa dalej. `yarn generate` po dołożeniu stron w VCAL-2.

Rollback VCAL-2 usuwa stronę i trasę kalendarza; lista, formularz i cała kontrola z VCAL-1 działają dalej. Rollback VCAL-1 wyłącza sprawdzenie i ukrywa dialog nadpisania, ale **zostawia kolumny, dane i historię** — powód, autor i czas nadpisania nie mogą zniknąć, bo są zapisem decyzji operatora. Wycofanie nie przywraca możliwości zapisu, który VCAL-1 uznał za blokujący, jeśli przyczyna dalej istnieje w `staff`; to zamierzone. Obserwowalność: liczniki konfliktów po kodzie i wadze oraz liczba nadpisań, bez treści powodów.

## Risks and Tradeoffs

| Ryzyko / kompromis | Wpływ | Ograniczenie / wykrycie | Ryzyko szczątkowe |
|---|---|---|---|
| Ostrzeżenie zmęczeniowe: zbyt wiele ostrzeżeń uczy klikania „zapisz mimo” bez czytania | Kontrola staje się dekoracją | Tylko cztery kody ostrzegają; brak grafiku daje `info`, nie ostrzeżenie; wymagany powód i komplet sygnatur; licznik nadpisań w obserwowalności | Organizacja z chaotycznymi grafikami i tak zobaczy dużo ostrzeżeń |
| Blokada nieobecnością zatrzymuje pilny przypadek | Rejestracja nie zapisze wizyty mimo zgody terapeuty | Jawna ścieżka naprawy przez `staff` z odnośnikiem do wniosku; komunikat mówi wprost, co zrobić (J3) | Naprawa wymaga osoby z prawem do wniosków urlopowych |
| Reguła `rrule` interpretowana inaczej niż w `planner` | Siatka i walidacja pokazują różne okna | Jedno wywołanie zainstalowanego `plannerAvailabilityService`, zero własnego parsera; testy porównujące okna z kartą zasobu | Zmiana zachowania scalania w kolejnej wersji pakietu zmienia też VCAL |
| Zmiana czasu letniego i strefy | Wizyta o godzinę obok, kolizja niewykryta | Porównania w UTC, `time_zone` VIS jawna, testy DST dla godziny nieistniejącej i podwójnej | Podwójną godzinę rozstrzyga człowiek, jak w VIS |
| Zapis między podglądem a zapisem (TOCTOU) | Nadpisanie zgody, której operator nie widział | Przeliczenie po blokadzie w transakcji, porównanie dokładnego zbioru sygnatur, 422 z nową listą | Operator musi przejrzeć listę drugi raz |
| Koszt odczytu przy szerokim zakresie | Wolny kalendarz, obciążenie bazy | Limit 62 dni, indeksy częściowe, jedno żądanie na zakres, cache po kluczu zakresu i filtrów | Organizacja z bardzo dużą liczbą wizyt może potrzebować węższego limitu |
| Wyciek danych kadrowych przez powód nieobecności | Rejestracja poznaje powody urlopów | `reasonLabel` tylko przy `staff.view`; powód nigdy w zdarzeniach i logach; test T07 | Sam fakt nieobecności pozostaje widoczny — jest niezbędny do planowania |
| Urlop zaakceptowany po zaplanowaniu wizyty | Wizyta zostaje w kolidującym terminie | Świadomy non-goal wstecznej rewizji; kalendarz pokazuje nałożenie przy otwarciu; kandydat na osobny raport | Bez raportu kolizja czeka na wzrok planisty |
| Zależność UI od `ScheduleView` | Zmiana prymitywu zmienia kalendarz | Prymityw design systemu z testami w pakiecie, `ds:check` w bramce | Brak zakładek kategorii i popoveru podglądu znanych z ekranu CRM |
| Podwójna rezerwacja bywa zamierzona (terapia grupowa) | Fałszywe ostrzeżenia | Waga ostrzegawcza, nie blokująca; nadpisanie z powodem daje ślad | Zajęcia grupowe wymagają nadpisania do czasu osobnej zdolności |

## Acceptance Criteria

- [ ] **VCAL-AC01** — Uprawniony planista otwiera kalendarz wizyt, przełącza dzień/tydzień/miesiąc/agenda i widzi w każdym z nich dokładnie te wizyty ze swojej organizacji, które zobaczyłby na liście; zakres i filtry są zapisane w adresie, a przekroczenie limitu zakresu jest odrzucane z podpowiedzią.
- [ ] **VCAL-AC02** — Kliknięcie wolnego slotu zakłada wizytę z wypełnionym terminem, a kliknięcie kafla otwiera ją do edycji; obie ścieżki używają tego samego formularza i tych samych komend co lista wizyt.
- [ ] **VCAL-AC03** — Kalendarz zawężony do wskazanego terapeuty pokazuje jego wizyty oraz pasma dostępności i nieobecności w tle; odnośnik do tego widoku otwiera to samo u innego użytkownika, z jego uprawnieniami. To samo działa dla gabinetu.
- [ ] **VCAL-AC04** — Zapis wizyty w oknie zaakceptowanego urlopu lub zwolnienia wykonawcy jest odrzucony z `visit_conflict_blocking` identycznie z kalendarza, z listy i przez API; wniosek `pending` lub odrzucony nie blokuje; termin poza grafikiem i podwójna rezerwacja ostrzegają; brak grafiku nie ostrzega.
- [ ] **VCAL-AC05** — Nieaktywny gabinet blokuje zapis; gabinet niedostępny regułą, poza grafikiem albo zajęty inną wizytą ostrzega; reguły przypięte przez `availability_rule_set_id` są uwzględniane.
- [ ] **VCAL-AC06** — Zapis mimo ostrzeżeń wymaga feature `patient.visits.override_conflict`, kompletu sygnatur i niepustego powodu; utrwala powód, autora, czas i kody; kolejny zapis bez ostrzeżeń je zeruje; brak uprawnienia daje 403 bez żadnego zapisu.
- [ ] **VCAL-AC07** — Przy wyłączonym module `planner` albo nieudanym odczycie reguł praca nie staje, odpowiedź niesie `availability_unknown`, UI mówi o tym wprost, a wykrywanie podwójnej rezerwacji i blokada nieaktywnego gabinetu działają dalej.
- [ ] **VCAL-AC08** — Izolacja tenantów i organizacji, zachowanie fail closed dla zakresu i uprawnień, przeliczenie konfliktów po blokadzie w transakcji, brak powodów i nazwisk w zdarzeniach i logach oraz ukrycie powodu nieobecności bez `staff.view` przechodzą testy; żaden test nie wymaga danych produkcyjnych.
- [ ] Każda wymieniona powierzchnia odpowiada zapisanej referencji Open Mercato i używa kanonicznej powłoki i komponentów, współdzielonych helperów API, semantycznych tokenów oraz kompletu stanów: ładowania, pustego, błędu, konfliktu, klawiatury, dostępności, responsywności oraz motywu jasnego i ciemnego.
- [ ] Każda nowa ścieżka API i UI ma samowystarczalne pokrycie integracyjne, a skonfigurowana bramka walidacyjna przechodzi.

## Final Compliance Report

| Sprawdzenie | Status | Dowód / rozstrzygnięcie |
|---|---|---|
| Przejrzane `AGENTS.md`, przypisane przewodniki i skille | pass | `AGENTS.md`, `.ai/guides/spec-delivery.md`, `SPEC-000-template.md`, `om-spec-writing`, `.ai/guides/backend-ui.md` + `om-backend-ui-design/references/quality-states.md`, `.ai/guides/upstream/BACKWARD_COMPATIBILITY.md`, fakty `staff`/`resources`/`planner`/`customers`, zainstalowane źródła wskazane w mapie reuse |
| Spójność modelu, API, zdarzeń, UI i testów | pass — projekt | Macierz konfliktów ↔ kontrakt nadpisania ↔ pola audytu ↔ VCAL-T02/T04/T05/T06 ↔ traceability |
| Każdy przepływ domyka się bez worka „integracja i poprawki” | pass — projekt | VCAL-1 dowozi kontrolę bez kalendarza, VCAL-2 dowozi kalendarz na gotowej kontroli; obie fazy mają własne bramki |
| Reuse platformy przed własnym kodem | pass — projekt | Reguły `planner`, urlopy przez `staff`, `plannerAvailabilityService`, `ScheduleView`, pickery hostów, komendy i dialogi VIS; zero nowych tabel grafiku, zero nowych zależności npm |
| Kontrakty UI wskazują referencje, komponenty i pokrycie stanów/motywów | pass — projekt | Tabela powierzchni z konkretnymi plikami zainstalowanymi, makiety, VCAL-T08 |
| Fazy mają zależności, wycinki, testy, wartość i obserwowalne bramki | pass — projekt | VCAL-1 i VCAL-2 z listą wycinków, oracles i kryteriami wyjścia |
| Zgodność wsteczna | pass — projekt | Zmiany addytywne: nowe pola opcjonalne, nowe trasy, nowy feature; kody konfliktów jako `enum` objęty protokołem deprecjacji |
| Brama Open Questions | pass — z zastrzeżeniem | Rozstrzygnięta autonomicznie; cztery założenia poniżej czekają na potwierdzenie człowieka |
| Zgoda na implementację | pass | Użytkownik zlecił pełną autonomiczną implementację VCAL-1 i VCAL-2 2026-09-30 |

**Verdict:** Ready for implementation — Q1–Q4 są potwierdzone, a wymagane VIS-1/VIS-2 są dostarczone i zweryfikowane w PR #3.

## Resolved assumptions (autonomous defaults)

Run autonomiczny; każde założenie wybrane jako najbardziej odwracalne i o najmniejszym zasięgu, zgodnie z regułami `om-spec-writing`. Każde da się odwrócić bez przepisywania modelu danych.

| Pytanie | Rozstrzygnięcie | Uzasadnienie | Odwrócenie |
|---|---|---|---|
| **Q1** — jedna specyfikacja czy dwie? | **Jedna, VCAL, dwie niezależnie wdrażalne fazy** | Obie fazy są osobno wdrażalne, więc obawa o spójność zakresu jest zaspokojona bez mnożenia dokumentów; użytkownik prosił o jedną specyfikację, a wspólna macierz konfliktów i tak musiałaby być cytowana w obu | Podział na dwa dokumenty po granicy faz, bez zmiany treści |
| **Q2** — odmowa czy ostrzeżenie? | **Dwie wagi: nieobecność kadrowa i nieaktywny gabinet blokują, reszta ostrzega z nadpisaniem i powodem** | Blokada wszystkiego uczy fałszowania terminów i zatrzymuje pilne przypadki; ostrzeganie o wszystkim sprawia, że sprawdzenie niczemu nie zapobiega, czyli nie realizuje briefu. Nieobecność ma właściciela (`staff`) i jasną ścieżkę naprawy, więc jej blokada nie jest ślepym zaułkiem | Zmiana wagi kodu w macierzy konfliktów; model i API bez zmian |
| **Q3** — co znaczy „zajęte”? | **Reguły `planner` + nakładające się własne wizyty; wydarzenia kalendarza CRM poza zakresem** | Bez nakładania wizyt sprawdzenie gabinetu byłoby niemal bezużyteczne, a odczyt własnej tabeli nie przekracza granicy modułu. Sięganie po `customers` dokładałoby zależność i dane spoza opieki | Dołożenie dostawcy zajętości do `evaluateVisitConflicts`; kontrakt API i kody bez zmian |
| **Q4** — komponent kalendarza? | **`ScheduleView` z `@open-mercato/ui/backend/schedule`** | Prymityw design systemu, używany przez `planner`, `staff` i `resources`, z tokenami i oboma motywami. Ekran CRM to wewnętrzna powierzchnia modułu `customers`, nie publiczny kontrakt; jego kopia byłaby drugą rodziną komponentów, wprost zakazaną w `.ai/guides/backend-ui.md` | Zamiana warstwy prezentacji w `VisitsCalendar.tsx`; trasa, dane i kontrolery bez zmian |

Dodatkowo, bez osobnego pytania: VCAL zakłada dostarczoną fazę VIS-1 i **nie** jest scalany z VIS, która jest zamknięta niezależnym przeglądem i ma własne fazy.

Żadne z założeń nie osłabia bezpieczeństwa, izolacji zakresu ani kontraktu zgodności wstecznej, więc żadne nie jest oznaczone jako wymagające zgody przed dalszą pracą projektową — wszystkie jednak wymagają potwierdzenia przed zmianą statusu na `Ready for implementation`.

## Open Questions

| ID | Pytanie | Właściciel | Blokuje? | Rozstrzygnięcie |
|---|---|---|---|---|
| Q-001 | Czy dwie wagi konfliktu (blokuje / ostrzega) odpowiadają praktyce recepcji? | Właściciel produktu | nie dla projektu, tak dla implementacji | Domyślnie rozstrzygnięte 2026-09-30, patrz Resolved assumptions |
| Q-002 | Czy `patient.visits.override_conflict` ma trafiać do roli rejestracji przy starcie? | Administrator organizacji | nie | Domyślnie nie; przyznanie jest świadomą decyzją |
| Q-003 | Czy potrzebny jest raport wizyt kolidujących z urlopem zaakceptowanym po ich zaplanowaniu? | Właściciel produktu | nie | Poza zakresem VCAL; kandydat na osobną zdolność |
| Q-004 | Czy limit zakresu 62 dni wystarcza dla widoku miesiąca z marginesem? | Właściciel produktu | nie | Przyjęty; zmiana to jedna stała i jeden test |

## Changelog

| Date | Change |
|---|---|
| 2026-09-30 | Szkielet VCAL: TLDR, problem, miary, mapa reuse z ustaleniem, że dostępność ma już silnik w `planner` + `staff` + `resources`; brama Open Questions Q1–Q4 |
| 2026-09-30 | Run autonomiczny: brama rozstrzygnięta (jedna specyfikacja z dwiema fazami; dwie wagi konfliktu; reguły `planner` + własne wizyty; `ScheduleView`); pełny dokument — macierz konfliktów, kontrakt nadpisania z sygnaturami, pola audytu i indeksy, dwie trasy API, kontrakty UI, dziesięć testów integracyjnych, fazy VCAL-1/VCAL-2, traceability, rollout, ryzyka i kryteria akceptacji |
| 2026-09-30 | Założenia Q1–Q4 potwierdzone przez jawne zlecenie pełnej autonomicznej implementacji; status zmieniony na Ready for implementation i powiązany z runem/PR #6 |
| 2026-09-30 | VCAL-1 zaimplementowana i potwierdzona checkpointem: kontrola w komendach i formularzu VIS, audyt nadpisania, produkcyjny build, migracja na dedykowanej bazie, testy przeglądarkowe i cztery screenshoty w PR #6 |
