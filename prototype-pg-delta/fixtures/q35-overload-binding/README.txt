Every load order succeeds, but the view binds to whichever pick() overload
exists when the view is created. Path order binds pick(numeric); creating all
functions first binds pick(integer). Same files, two different desired schemas.
