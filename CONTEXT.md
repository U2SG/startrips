# Living Atlas

Living Atlas is a private, shared record of journeys. Its language treats movement through the world as the primary subject; cities and named places are optional annotations, not the boundary of a journey.

## Language

**Atlas**:
A private collection of journeys shared by its members.
_Avoid_: Gallery, archive, account

**Journey**:
A bounded travel experience that may remain in one area, cross many places, or consist mainly of movement. A journey owns one route, its overall story, and any media that is not tied to a single route point.
_Avoid_: Memory, city visit, location

**Route**:
The ordered geographic path of a journey. It may be defined sparsely or precisely and must not imply that every point is a named place.
_Avoid_: Location, destination, city list

**Route Point**:
An ordered coordinate that shapes a route. It may represent a stop, an unnamed pass-through position, or a point recorded while in transit, and may own media captured there.
_Avoid_: City, place

**Route Point Media**:
A private photo or video attached to one exact route point. Media that describes the whole journey may remain attached only to the journey.
_Avoid_: Stop media, city media

**Route Segment**:
The portion of a route between two consecutive route points. A journey can be entirely composed of movement across route segments.
_Avoid_: Stop, destination

**Stop**:
A route point intentionally marked as a meaningful visited place. Stops are optional; a valid journey does not require one.
_Avoid_: Route point, city

**Place Label**:
Optional human-readable context attached to a route point, such as a city, station, road, or landmark. It describes a point but does not define the journey.
_Avoid_: Journey title, route

**Home Base / 常住地**:
A member-confirmed city or metro-level life base that held for one period of a member's life. It is not a residential address, not a route point, and not a claim that any journey physically departed from it.
_Avoid_: Home, address, origin, hometown

**Home Base Period / 常住地阶段**:
The effective interval of one home base, `startedOn <= date < endedOn`, with `endedOn = null` for the current period. A move creates a new period instead of overwriting history, so a journey resolves the home base that applied to its own date.
_Avoid_: Current home, move date, relocation event

## Implementation invariants

- Browser payload order defines Route Point order; clients never provide database `sortOrder` values.
- Atlas ownership is derived from the authenticated active Organization on the server, never from a browser-supplied atlas or organization ID.
- Journey metadata and its complete ordered Route are written atomically.
- Media belongs to a Journey and may additionally belong to one Route Point in that Journey. It stays private and is read through short-lived signed URLs only after tenant authorization.
- Persisted Route size and rendered geometry budgets are separate. The client may simplify or omit old geometry without changing the saved Journey.
- Sparse routes are approximate paths, not a claim that every point was GPS-recorded.
- Location search and object storage are optional deployment adapters. Their absence must degrade truthfully, without fake results or fake persistence.
- Home base history is atlas-owned and resolved by date. Adding a later period never changes which home base an earlier journey resolves to, no home base value is written onto a route point, and home base history is never part of a guest share payload.
