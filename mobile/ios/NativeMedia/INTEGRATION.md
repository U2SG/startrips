# Native media on iPhone

The Startrips scheme links the local StartripsMedia product. The Atlas scene opens Story through the app navigation stack. StoryDestination uses the live AtlasSession and the authorized Journey response to build the native viewer. Guest responses derive media order from server array order and never use owner cookies. The scene receives only its narrower projection.

A manual exit restores the committed media position; exiting Journey Playback first returns to Story. Finishing the journey returns to Atlas. The background transfer delegate reattaches the original session using a digest of the owner scope. Upload recovery uses the server's read-only status endpoint from #769. Photo import, move, undo and MP4 export are available to the owner through the Story tools.

Use mobile/ios/ci-test.sh on an Apple runner. It runs the package tests and the app unit and UI tests sequentially on the same iPhone simulator. The UI fixture uses the normal Atlas-to-Story entry with synthetic photos and no private credentials.
