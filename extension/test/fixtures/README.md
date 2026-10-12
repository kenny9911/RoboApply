# Form fixtures

Hand-built, anonymized reproductions of the public application-form markup of
each supported form host (structure, ids, names and class names as the hosts
render them; no employer content, no personal data). Company and role names
are fictional. Each adapter has at least three fixtures; tests assert field
coverage, value round-trip and file attach, and that nothing submit-like is
ever pressed.

Refresh a fixture by saving a live application page (File → Save Page As,
"HTML only"), deleting scripts, tracking pixels and any employer text that is
not needed for the form structure, and keeping the ids/names intact.
