#!/usr/bin/env python3
"""
Create the WV GeoGuess hosted layers and views in ArcGIS Online (brief §3.1).
docs/AGOL_SETUP.md describes the same setup as manual steps; this script is
the faster path. Either way, verify afterwards with tools/check-agol.html.

    DRY RUN (default) — prints what would be created, touches nothing:
        python scripts/create_layers.py

    APPLY — creates what's missing, then reads everything back and checks it:
        python scripts/create_layers.py --apply --portal https://YOURORG.maps.arcgis.com --username YOU
            (prompts for the password; nothing is stored)
        python scripts/create_layers.py --apply --portal https://YOURORG.maps.arcgis.com --client-id APPID
            (single sign-on: opens a browser sign-in; APPID is an OAuth client ID)

    In an ArcGIS Online Notebook (no local install needed), paste this file
    into a cell, then run:   main(["--apply", "--home"])

Re-running is safe: items that already exist (same title, same owner) are
skipped, not replaced. Nothing is ever deleted except the one test row the
JSON-length check writes to the State table (session "test-setup-check").

Requires the ArcGIS API for Python (pip install arcgis) for --apply only.
"""
import argparse
import getpass
import json
import sys

# ---------------------------------------------------------------------------
# The spec. Field names must match js/backend.js (STATE_FIELDS, GUESS_FIELDS,
# LANDMARK_FIELDS).
# ---------------------------------------------------------------------------

# Requested length for reveal_json / leaderboard_json. The script reads the
# real length back and round-trips a value this long, because AGOL's maximum
# isn't documented. Put the confirmed number in CONFIG.live.jsonFieldLength.
JSON_FIELD_LENGTH = 64000

WKID = 102100  # must match CONFIG.live.agol.guessLayerWkid (addFeatures has no inSR)
# WV extent in Web Mercator (from data/wv-boundary.geojson, padded a little)
WV_EXTENT = {
    "xmin": -9210000, "ymin": 4460000, "xmax": -8640000, "ymax": 4970000,
    "spatialReference": {"wkid": WKID},
}


def s(name, length, alias=None):
    return {"name": name, "type": "esriFieldTypeString", "alias": alias or name,
            "length": length, "nullable": True, "editable": True}


def i(name, alias=None):
    return {"name": name, "type": "esriFieldTypeInteger", "alias": alias or name,
            "nullable": True, "editable": True}


def d(name, alias=None):
    return {"name": name, "type": "esriFieldTypeDouble", "alias": alias or name,
            "nullable": True, "editable": True}


OID = {"name": "OBJECTID", "type": "esriFieldTypeOID", "alias": "OBJECTID",
       "nullable": False, "editable": False}

FULL_EDIT = "Create,Delete,Query,Update,Editing"

SERVICES = [
    {
        "title": "WV_GeoGuess_Landmarks",
        "snippet": "WV GeoGuess answers (polygons). PRIVATE — never share.",
        "kind": "layers",
        "layer": {
            "name": "Landmarks", "type": "Feature Layer",
            "geometryType": "esriGeometryPolygon",
            "fields": [OID, s("landmark_id", 16), s("name", 128), s("prompt_text", 256),
                       s("set_name", 64), i("round_order"), s("image_path", 256),
                       s("fun_fact", 1000), s("credit", 256)],
        },
        "editor_tracking": False,
    },
    {
        "title": "WV_GeoGuess_State",
        "snippet": "WV GeoGuess session state (one row per session). Owner-edited.",
        "kind": "tables",
        "layer": {
            "name": "State", "type": "Table",
            "fields": [OID, s("session_id", 40), s("phase", 16), i("round_num"),
                       i("round_total"), s("set_name", 64), s("image_path", 256),
                       s("prompt_text", 256), d("round_ends_at"),
                       s("reveal_json", JSON_FIELD_LENGTH),
                       s("leaderboard_json", JSON_FIELD_LENGTH), d("updated_at")],
            "indexes": [{"name": "idx_session", "fields": "session_id",
                         "isAscending": True, "isUnique": False}],
        },
        "editor_tracking": False,
    },
    {
        "title": "WV_GeoGuess_Guesses",
        "snippet": "WV GeoGuess player guesses (points). Owner reads; public adds via view.",
        "kind": "layers",
        "layer": {
            "name": "Guesses", "type": "Feature Layer",
            "geometryType": "esriGeometryPoint",
            "fields": [OID, s("session_id", 40), i("round_num"), s("player_id", 40),
                       s("nickname", 24), d("client_ts")],
            "indexes": [{"name": "idx_session_round", "fields": "session_id,round_num",
                         "isAscending": True, "isUnique": False}],
        },
        # CreationDate (server time) is how late guesses are rejected.
        "editor_tracking": True,
    },
]

VIEWS = [
    {
        "title": "WV_GeoGuess_State_Public",
        "source": "WV_GeoGuess_State",
        "snippet": "Read-only public view of WV GeoGuess state. Phones poll this.",
        "capabilities": "Query",
        "definition": {"cacheMaxAge": 0},  # lowest CDN cache (0–3600 s allowed)
        "share_everyone": True,
    },
    {
        "title": "WV_GeoGuess_Guesses_Public",
        "source": "WV_GeoGuess_Guesses",
        "snippet": "Add-only, blind public view for WV GeoGuess guesses.",
        # "Add" only + "Editors can't see any features, even those they add"
        # = Create without Query.
        "capabilities": "Create,Editing",
        "definition": {
            "editorTrackingInfo": {
                "enableEditorTracking": True,
                "enableOwnershipAccessControl": True,
                "allowOthersToQuery": False,
                "allowOthersToUpdate": False,
                "allowOthersToDelete": False,
                "allowAnonymousToQuery": False,
                "allowAnonymousToUpdate": False,
                "allowAnonymousToDelete": False,
            },
        },
        "share_everyone": True,
    },
    {
        "title": "WV_GeoGuess_Landmarks_Solo",
        "source": "WV_GeoGuess_Landmarks",
        "snippet": "Read-only view of the answers for solo mode. Keep PRIVATE until after the event.",
        "capabilities": "Query",
        "definition": {},
        "share_everyone": False,  # share only for Fallback A or after GIS Day
    },
]


def layer_definition(svc):
    lyr = dict(svc["layer"])
    lyr.update({
        "id": 0,
        "objectIdField": "OBJECTID",
        "displayField": lyr["fields"][1]["name"],
        "capabilities": FULL_EDIT,
        "maxRecordCount": 2000,
        "hasAttachments": False,
        "supportsRollbackOnFailureParameter": True,
    })
    if lyr["type"] == "Feature Layer":
        lyr["extent"] = WV_EXTENT
    return {svc["kind"]: [lyr]}


# ---------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------

def dry_run():
    print("DRY RUN — nothing will be created. Add --apply to create.\n")
    for svc in SERVICES:
        print(f"SERVICE  {svc['title']}  (private)  wkid={WKID}  editor tracking={svc['editor_tracking']}")
        for f in svc["layer"]["fields"][1:]:
            extra = f" ({f['length']})" if "length" in f else ""
            print(f"    {f['name']:<18} {f['type'].replace('esriFieldType', '')}{extra}")
        json.dumps(layer_definition(svc))  # make sure it serializes
    for v in VIEWS:
        share = "EVERYONE" if v["share_everyone"] else "private"
        print(f"VIEW     {v['title']}  of {v['source']}  capabilities={v['capabilities']}  "
              f"sharing={share}  {json.dumps(v['definition']) if v['definition'] else ''}")
    print("\nManual step after --apply (not scriptable, see docs/AGOL_SETUP.md §4):")
    print("  WV_GeoGuess_Guesses_Public > Settings > approve the layer for public editing.")


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------

def connect(args):
    from arcgis.gis import GIS

    if args.home:
        return GIS("home")
    if not args.portal:
        sys.exit("--portal is required (or --home inside an ArcGIS Notebook)")
    if args.client_id:
        return GIS(args.portal, client_id=args.client_id)
    if not args.username:
        sys.exit("--username or --client-id is required")
    return GIS(args.portal, args.username, getpass.getpass(f"Password for {args.username}: "))


def find_owned(gis, title):
    me = gis.users.me.username
    for item in gis.content.search(f'title:"{title}" AND owner:{me}', item_type="Feature Layer", max_items=50):
        if item.title == title:
            return item
    return None


def share_everyone(item):
    try:
        item.sharing.sharing_level = "EVERYONE"  # arcgis >= 2.3
    except AttributeError:
        item.share(everyone=True)  # older versions


def apply(args):
    from arcgis.features import FeatureLayerCollection

    gis = connect(args)
    print(f"Signed in to {gis.properties.portalHostname} as {gis.users.me.username}\n")
    items = {}

    for svc in SERVICES:
        item = find_owned(gis, svc["title"])
        if item:
            print(f"exists   {svc['title']}  ({item.id}) — skipped")
        else:
            item = gis.content.create_service(
                name=svc["title"], has_static_data=False, max_record_count=2000,
                capabilities=FULL_EDIT, wkid=WKID,
            )
            item.update(item_properties={"title": svc["title"], "snippet": svc["snippet"],
                                         "tags": "WV GeoGuess, GIS Day"})
            flc = FeatureLayerCollection.fromitem(item)
            flc.manager.add_to_definition(layer_definition(svc))
            if svc["editor_tracking"]:
                flc.manager.update_definition({"editorTrackingInfo": {
                    "enableEditorTracking": True, "enableOwnershipAccessControl": False,
                    "allowOthersToQuery": True, "allowOthersToUpdate": True,
                    "allowOthersToDelete": True, "allowAnonymousToQuery": True,
                    "allowAnonymousToUpdate": True, "allowAnonymousToDelete": True,
                }})
            print(f"created  {svc['title']}  ({item.id})")
        items[svc["title"]] = item

    for v in VIEWS:
        item = find_owned(gis, v["title"])
        if item:
            print(f"exists   {v['title']}  ({item.id}) — skipped")
        else:
            src = FeatureLayerCollection.fromitem(items[v["source"]])
            item = src.manager.create_view(name=v["title"], capabilities=v["capabilities"],
                                           snippet=v["snippet"])
            vflc = FeatureLayerCollection.fromitem(item)
            vflc.manager.update_definition({"capabilities": v["capabilities"], **v["definition"]})
            if v["share_everyone"]:
                share_everyone(item)
            print(f"created  {v['title']}  ({item.id})")
        items[v["title"]] = item

    ok = verify(items)
    print_config(items)
    sys.exit(0 if ok else 1)


# ---------------------------------------------------------------------------
# Verify (reads everything back)
# ---------------------------------------------------------------------------

def verify(items):
    from arcgis.features import FeatureLayerCollection

    print("\nVERIFY")
    ok = True

    def check(cond, msg):
        nonlocal ok
        print(f"  {'ok  ' if cond else 'FAIL'} {msg}")
        ok &= bool(cond)

    for svc in SERVICES:
        flc = FeatureLayerCollection.fromitem(items[svc["title"]])
        lyr = (flc.tables if svc["kind"] == "tables" else flc.layers)[0]
        props = lyr.properties
        got = {f["name"]: f for f in props.fields}
        for f in svc["layer"]["fields"][1:]:
            g = got.get(f["name"])
            check(g is not None and g["type"] == f["type"], f"{svc['title']}.{f['name']} exists as {f['type']}")
            if g and "length" in f:
                check(g.get("length", 0) >= f["length"],
                      f"{svc['title']}.{f['name']} length {g.get('length')} >= {f['length']}")
        check(_sharing(items[svc["title"]]) == "private", f"{svc['title']} is private")
        if svc["editor_tracking"]:
            efi = props.get("editFieldsInfo") or {}
            check(efi.get("creationDateField") == "CreationDate",
                  f"{svc['title']} editor tracking (creationDateField={efi.get('creationDateField')})")
        if svc["kind"] == "layers":
            check(props.extent["spatialReference"].get("latestWkid", props.extent["spatialReference"].get("wkid")) in (3857, 102100),
                  f"{svc['title']} is Web Mercator")

    for v in VIEWS:
        vflc = FeatureLayerCollection.fromitem(items[v["title"]])
        caps = set(vflc.properties.capabilities.split(","))
        want = set(v["capabilities"].split(","))
        check(caps == want, f"{v['title']} capabilities {sorted(caps)} == {sorted(want)}")
        want_share = "everyone" if v["share_everyone"] else "private"
        check(_sharing(items[v["title"]]) == want_share, f"{v['title']} sharing is {want_share}")
        if "cacheMaxAge" in v["definition"]:
            check(vflc.properties.get("cacheMaxAge") == 0,
                  f"{v['title']} cacheMaxAge={vflc.properties.get('cacheMaxAge')} (want 0)")

    check(json_roundtrip(items["WV_GeoGuess_State"]), f"State JSON fields round-trip {JSON_FIELD_LENGTH} chars")
    print("  (Public-editing approval and anonymous access are checked by tools/check-agol.html.)")
    return ok


def _sharing(item):
    try:
        return str(item.sharing.sharing_level).split(".")[-1].lower()
    except AttributeError:
        acc = item.access  # older versions: "private" | "org" | "shared" | "public"
        return "everyone" if acc == "public" else acc


def json_roundtrip(item):
    """Write a JSON_FIELD_LENGTH-char value, read it back, delete the row."""
    from arcgis.features import FeatureLayerCollection

    table = FeatureLayerCollection.fromitem(item).tables[0]
    payload = json.dumps({"pad": "x" * (JSON_FIELD_LENGTH - 10)})[:JSON_FIELD_LENGTH]
    res = table.edit_features(adds=[{"attributes": {"session_id": "test-setup-check",
                                                    "phase": "lobby", "reveal_json": payload}}])
    add = res["addResults"][0]
    if not add.get("success"):
        print(f"       add failed: {add.get('error')}")
        return False
    try:
        rows = table.query(where="session_id = 'test-setup-check'", out_fields="reveal_json").features
        got = rows[0].attributes["reveal_json"] if rows else None
        same = got == payload
        if not same:
            print(f"       read back {len(got or '')} of {len(payload)} chars")
        return same
    finally:
        table.edit_features(deletes=[add["objectId"]])


def print_config(items):
    def url(title):
        return items[title].url.rstrip("/") + "/0"

    print("\nPaste into config.js → live.agol:")
    print(f'''            landmarksUrl: "{url("WV_GeoGuess_Landmarks")}",
            stateUrl: "{url("WV_GeoGuess_State")}",
            statePublicUrl: "{url("WV_GeoGuess_State_Public")}",
            guessesUrl: "{url("WV_GeoGuess_Guesses")}",
            guessesPublicUrl: "{url("WV_GeoGuess_Guesses_Public")}",''')
    print(f"\nAnd set live.jsonFieldLength to {JSON_FIELD_LENGTH} if the round-trip check passed.")


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="actually create (default is a dry run)")
    ap.add_argument("--portal", help="e.g. https://YOURORG.maps.arcgis.com")
    ap.add_argument("--username", help="ArcGIS account (built-in login); password is prompted")
    ap.add_argument("--client-id", help="OAuth client ID for single sign-on (browser sign-in)")
    ap.add_argument("--home", action="store_true", help='use GIS("home") inside an ArcGIS Notebook')
    args = ap.parse_args(argv)
    if args.apply:
        apply(args)
    else:
        dry_run()


if __name__ == "__main__":
    main()
