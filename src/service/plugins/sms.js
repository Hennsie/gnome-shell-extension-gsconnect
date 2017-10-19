/**
 * sms.js - A simple dialog for sending SMS messages with GSConnect/KDE Connect
 * with (optional) Google Contacts auto-completion via Gnome Online Accounts.
 *
 * A great deal of credit and appreciation is owed to the indicator-kdeconnect
 * developers for the sister Python script 'Sms.py':
 * 
 * https://github.com/Bajoja/indicator-kdeconnect/blob/master/src/sms/Sms.py
 */

const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

try {
    var GData = imports.gi.GData;
    var Goa = imports.gi.Goa;
} catch (e) {
    var GData = undefined;
    var Goa = undefined;
}

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;


/**
 * Phone Number types that support receiving texts
 */
const SUPPORTED_NUMBER_TYPES = [
    // GData: https://developers.google.com/gdata/docs/2.0/elements#rel-values_71
    "http://schemas.google.com/g/2005#home",
    "http://schemas.google.com/g/2005#main",
    "http://schemas.google.com/g/2005#mobile",
    "http://schemas.google.com/g/2005#other",
    "http://schemas.google.com/g/2005#pager",
    "http://schemas.google.com/g/2005#work",
    "http://schemas.google.com/g/2005#work_mobile",
    "http://schemas.google.com/g/2005#work_pager",
    // Folks: http://www.ietf.org/rfc/rfc2426.txt
    "home",
    "cell",     // Equal to GData->mobile
    "pager",
    "pref",     // Equal to GData->main
    "work",
    "voice"     // Sometimes mapped from GData#work
];

/**
 * SMS Message direction
 */
var MessageDirection = {
    OUT: 0,
    IN: 1
};


/**
 * Message Bubble Colours
 * See: https://developer.gnome.org/hig/stable/icons-and-artwork.html
 *      http://tango.freedesktop.org/Tango_Icon_Theme_Guidelines#Color_Palette
 *      http://leaverou.github.io/contrast-ratio/
 */
var MessageStyle = new Gtk.CssProvider();
// TODO: MessageStyle.load_from_resource("/style/sms.css");
MessageStyle.load_from_data(
    ".contact-avatar { border-radius: 16px; } " +
    ".message-bubble { border-radius: 1em; } " +
    
    ".contact-color-red { color: #ffffff; background-color: #cc0000; } " +
    ".contact-color-orange { color: #000000; background-color: #f57900; } " +
    ".contact-color-yellow { color: #000000; background-color: #edd440; } " +
    ".contact-color-green { color: #ffffff; background-color: #4e9a06; } " +
    ".contact-color-blue { color: #ffffff; background-color: #204a87; } " +
    ".contact-color-purple { color: #ffffff; background-color: #5c3566; } " +
    ".contact-color-brown { color: #ffffff; background-color: #8f5902; } " +
    ".contact-color-grey { color: #000000; background-color: #d3d7cf; } "
);
        
        
/** A Gtk.EntryCompletion subclass for Google Contacts */
var ContactCompletion = new Lang.Class({
    Name: "GSConnectContactCompletion",
    Extends: Gtk.EntryCompletion,
    Properties: {
        "provider": GObject.ParamSpec.string(
            "provider",
            "ContactsProvider",
            "The provider for contacts",
            GObject.ParamFlags.READWRITE,
            "none"
        )
    },
    
    _init: function () {
        this.parent();
        
        // Track suggested completions
        this._matched = [];
        this._last = null;
        
        // Phone number icons
        let theme = Gtk.IconTheme.get_default();
        this.phone_number_default = theme.load_icon("phone-number-default", 0, 0);
        this.phone_number_home = theme.load_icon("phone-number-home", 0, 0);
        this.phone_number_mobile = theme.load_icon("phone-number-mobile", 0, 0);
        this.phone_number_work = theme.load_icon("phone-number-work", 0, 0);
        
        // Define a completion model
        let listStore = new Gtk.ListStore();
        listStore.set_column_types([
            GObject.TYPE_STRING,    // Title ("Name <Phone Number>")
            GObject.TYPE_STRING,    // Name
            GObject.TYPE_STRING,    // Phone Number
            GdkPixbuf.Pixbuf        // Type Icon
        ]);
        listStore.set_sort_column_id(0, Gtk.SortType.ASCENDING);
        listStore.set_sort_func(1, this._levenshtein, null, null);
        this.set_model(listStore);
        
        // Title
        this.set_text_column(0);
        // Type Icon
        let typeCell = new Gtk.CellRendererPixbuf();
        this.pack_start(typeCell, false);
        this.add_attribute(typeCell, "pixbuf", 3);
        
        this.set_match_func(Lang.bind(this, this._match), null, null);
        this.connect("match-selected", Lang.bind(this, this._select));
        
        this._get_contacts();
    },
    
    /** Spawn folks.py */
    _get_contacts: function () {
        let envp = GLib.get_environ();
        envp.push("FOLKS_BACKENDS_DISABLED=telepathy")
        
        let proc = GLib.spawn_async_with_pipes(
            null,                                   // working dir
            ["python3", getPath() + "/folks.py"],   // argv
            envp,                                   // envp
            GLib.SpawnFlags.SEARCH_PATH,            // enables PATH
            null                                    // child_setup (func)
        );
        
        this._check_folks(proc);
    },
    
    /** Check spawned folks.py for errors on stderr */
    _check_folks: function (proc) {
        let errstream = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: proc[4] })
        });
        
        GLib.spawn_close_pid(proc[1]);
    
        errstream.read_line_async(GLib.PRIORITY_LOW, null, (source, res) => {
            let [errline, length] = source.read_line_finish(res);
            
            if (errline === null) {
                let stream = new Gio.DataInputStream({
                    base_stream: new Gio.UnixInputStream({ fd: proc[3] })
                });
                
                this.provider = "avatar-default-symbolic";
                this.notify("provider");
                
                this._read_folk(stream)
            } else {
                Common.debug("SMS: Error reading folks.py: " + errline);
                
                try {
                    for (let account in this._get_google_accounts()) {
                        this._get_google_contacts(account);
                        this.provider = "goa-account-google";
                        this.notify("provider");
                    }
                } catch (e) {
                    Common.debug("SMS: Error reading Google Contacts: " + e);
                }
            }
        });
        
    },
    
    /** Read a folk from folks.py output */
    _read_folk: function (stream) {
        stream.read_line_async(GLib.PRIORITY_LOW, null, (source, res) => {
            let [contact, length] = source.read_line_finish(res);
            
            if (contact !== null) {
                let [name, number, type] = contact.toString().split("\t");
                this._add_contact(name, number, type);
                this._read_folk(stream);
            }
        });
    },
    
    /** Get all google accounts in Goa */
    _get_google_accounts: function () {
        let goaClient = Goa.Client.new_sync(null, null);
        let goaAccounts = goaClient.get_accounts();
        
        for (let goaAccount in goaAccounts) {
            let acct = goaAccounts[goaAccount].get_account();
            
            if (acct.provider_type === "google") {
                yield new GData.ContactsService({
                    authorizer: new GData.GoaAuthorizer({
                        goa_object: goaClient.lookup_by_id(acct.id)
                    })
                })
            }
        }
    },
    
    /** Query google contacts via GData */
    _get_google_contacts: function (account) {
        let query = new GData.Query({ q: "" });
        let count = 0;
        
        while (true) {
            let feed = account.query_contacts(
                query, // query,
                null, // cancellable
                (contact) => {
                    for (let phoneNumber of contact.get_phone_numbers()) {
                        this._add_contact(
                            contact.title,
                            phoneNumber.number,
                            phoneNumber.relation_type
                        );
                    }
                },
                null
            );
            
            count += feed.items_per_page;
            query.start_index = count;
            
            if (count > feed.total_results) { break; }
        }
    },
    
    /** Add contact */
    _add_contact: function (name, number, type) {
        // Only include types that could possibly support SMS
        if (SUPPORTED_NUMBER_TYPES.indexOf(type) < 0) { return; }
    
        // Append the number to the title column
        let title = name + " <" + number + ">";
        
        // Phone Type Icon
        if (type.indexOf("home") > -1) {
            type = this.phone_number_home;
        } else if (type.indexOf("cell") > -1 || type.indexOf("mobile") > -1) {
            type = this.phone_number_mobile;
        } else if (type.indexOf("work") > -1 || type.indexOf("voice") > -1) {
            type = this.phone_number_work;
        } else {
            type = this.phone_number_default;
        }
    
        this.model.set(
            this.model.append(),
            [0, 1, 2, 3],
            [title, name, number, type]
        );
    },
    
    /** Multi-recipient capable match function */
    _match: function (completion, key, tree_iter) {
        let model = completion.get_model();
        let title = model.get_value(tree_iter, 0).toLowerCase();
        let name = model.get_value(tree_iter, 1).toLowerCase();
        let number = model.get_value(tree_iter, 2);
        
        let currentContacts = key.split(";").slice(0, -1);
        
        // Set key to the last or only search item, trimmed of whitespace
        if (key.indexOf(";") > -1) { key = key.split(";").pop().trim(); }
        
        // Return if the possible match is in the current list
        if (currentContacts.indexOf(title) > -1) { return false; }
        
        // Clear current matches, reset last key and return if the key is empty
        if (!key.length) {
            this._matched = [];
            this._last = null;
            return;
        // Clear current matches and reset last key if the key has changed
        } else if (key !== this._last) {
            this._matched = [];
            this._last = key;
        }
        
        if (this._matched.length >= 20) { return false; }
        
        // Match name or number
        if (name.indexOf(key) > -1 || number.indexOf(key) > -1) {
            this._matched.push(model.get_string_from_iter(tree_iter));
            return true;
        }
    },
    
    /** Add selected auto-complete entry to list of contacts in the entry */
    _select: function (completion, model, tree_iter) {
        let entry = completion.get_entry();
        
        entry.set_text(model.get_value(tree_iter, 0) + "; ");
        entry.set_position(-1);
        this._matched = [];
        
        // TODO: use a signal instead?
        entry.notify("recipients");
        
        return true;
    },
    
    /** 
     * A levenshtein sort function
     * See: https://gist.github.com/andrei-m/982927#gistcomment-2059365
     */
    _levenshtein: function (model, a, b, user_data) {
	    var tmp;
	    if (a.length === 0) { return b.length; }
	    if (b.length === 0) { return a.length; }
	    if (a.length > b.length) { tmp = a; a = b; b = tmp; }

	    var i, j, res, alen = a.length, blen = b.length, row = Array(alen);
	    for (i = 0; i <= alen; i++) { row[i] = i; }

	    for (i = 1; i <= blen; i++) {
		    res = i;
		    for (j = 1; j <= alen; j++) {
			    tmp = row[j - 1];
			    row[j - 1] = res;
			    res = b[i - 1] === a[j - 1] ? tmp : Math.min(tmp + 1, Math.min(res + 1, row[j] + 1));
		    }
	    }
	    
	    return res;
    }
});


/**
 * A Gtk.Entry subclass for contact names and phone numbers
 */
var ContactEntry = new Lang.Class({
    Name: "GSConnectContactEntry",
    Extends: Gtk.Entry,
    Properties: {
        "recipients": GObject.param_spec_variant(
            "recipients",
            "RecipientList", 
            "A list of target recipient phone numbers",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        )
    },
    
    _init: function (completion) {
        this.parent({
            hexpand: true,
            placeholder_text: _("Type a phone number"),
            primary_icon_name: "call-start-symbolic",
            primary_icon_activatable: false,
            primary_icon_sensitive: true,
            input_purpose: Gtk.InputPurpose.PHONE,
            completion: completion
        });
        
        // TODO: make singleton?
        this.completion.connect("notify::provider", (completion) => {
            this.placeholder_text = _("Type a phone number or name");
            this.primary_icon_name = this.completion.provider;
            this.input_purpose = Gtk.InputPurpose.FREE_FORM;
        });
    
        // Select the first completion suggestion on "activate"
        this.connect("activate", () => { this._select(this); });
        
        // Workaround for empty searches not calling CompletionMatchFunc
        this.connect("changed", (entry) => {
            let styleContext = entry.get_style_context();
            
            if (entry.text === "") {
                let completion = entry.get_completion();
                completion._matched = [];
                completion._last = null;
            } else if (styleContext.has_class("error")) {
                styleContext.remove_class("error");
            }
        });
        
        this.connect("activate", () => {
            this.notify("recipients");
        });
    },
    
    _select: function (entry) {
        let completion = entry.get_completion();
        
        if (completion._matched.length > 0) {
            let iter_path = completion._matched["0"];
            let [b, iter] = completion.model.get_iter_from_string(iter_path);
        
            entry.set_text(completion.model.get_value(iter, 0) + "; ");
            entry.set_position(-1);
            completion._matched = [];
            
            this.notify("recipients");
        }
    },
    
    get recipients () {
        let contactItems = this.text.split(";").filter((s) => {
            return /\S/.test(s);
        });
        let recipients = new Map();
        let model = this.get_completion().get_model();
        
        for (let item of contactItems) {
            item = item.trim();
            let contact = false;
            
            // Search the completion for a matching known contact
            model.foreach((model, path, tree_iter) => {
                if (item === model.get_value(tree_iter, 0)) {
                    contact = [
                        model.get_value(tree_iter, 1), // Name
                        model.get_value(tree_iter, 2) // Phone Number
                    ];
                    
                    return true;
                }
                
                contact = false;
            });
            
            // Found a matching known contact
            if (contact) {
                recipients.set(contact[0], contact[1]);
            // Just return the contact "item" as is
            } else {
                recipients.set(item, item);
            }
        }
        
        return recipients;
    }
});


/**
 * Contact Avatar
 */
var ContactAvatar = new Lang.Class({
    Name: "GSConnectContactAvatar",
    Extends: Gtk.DrawingArea,
    
    _init: function (phoneThumbnail, win, size) {
        this.parent({
            height_request: size,
            width_request: size
        });
        
        this.size = size;
        
        let image_stream = Gio.MemoryInputStream.new_from_data(
            GLib.base64_decode(phoneThumbnail),
            GLib.free
        );
        
        this._pixbuf = GdkPixbuf.Pixbuf.new_from_stream(
            image_stream,
            null
        ).scale_simple(this.size, this.size, GdkPixbuf.InterpType.HYPER);
        
        this._surface = Gdk.cairo_surface_create_from_pixbuf(
            this._pixbuf,
            0,
            win.get_window()
        );
        
        this.connect("draw", (widget, cr) => {
            this._draw(widget, cr);
            return false;
        });
    },
    
    _draw: function (widget, cr) {
        cr.setSourceSurface(this._surface, 0, 0);
        cr.arc(this.size/2, this.size/2, this.size/2, 0, 2*Math.PI);
        cr.clip();
        cr.paint();
    }
});


/**
 * A Gtk.ScrolledWindow with Gtk.ListBox for storing current recipients
 */
var RecipientList = new Lang.Class({
    Name: "GSConnectRecipientList",
    Extends: Gtk.ScrolledWindow,
    Signals: {
        "remove-recipient": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        }
    },
    
    _init: function () {
        this.parent({
            can_focus: false,
            hexpand: true,
            vexpand: true
        });
        
        let frame = new Gtk.Frame();
        this.add(frame);
        
        this.list = new Gtk.ListBox({
            visible: true,
            halign: Gtk.Align.FILL
        });
        frame.add(this.list);
    },
    
    addRecipient: function (phoneNumber, contactName, phoneThumbnail) {
        let recipient = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false,
            hexpand: true,
            halign: Gtk.Align.FILL,
            visible: true,
            margin: 6
        });
        this.list.add(recipient);
        
        recipient.layout = new Gtk.Grid({
            visible: true,
            can_focus: false,
            column_spacing: 12,
            row_spacing: 0,
            margin_left: 12,
            margin_top: 6,
            margin_bottom: 6,
            margin_right: 12
        });
        recipient.add(recipient.layout);
        
        // Contact Avatar
        // TODO: GdkPixbuf chokes hard on non-fatally corrupted images
        try {
            recipient.avatar = new ContactAvatar(
                phoneThumbnail,
                this.get_toplevel(),
                32
            );
        } catch (e) {
            Common.debug("Error creating avatar: " + e);
        
            recipient.avatar = new Gtk.Box({
                width_request: 32,
                height_request: 32
            });
            let avatarStyle = recipient.avatar.get_style_context();
            avatarStyle.add_provider(MessageStyle, 0);
            avatarStyle.add_class("contact-avatar");
            avatarStyle.add_class("contact-color-orange");
            
            let defaultAvatar = Gtk.Image.new_from_icon_name(
                "avatar-default-symbolic",
                Gtk.IconSize.LARGE_TOOLBAR
            );
            defaultAvatar.visible = true;
            defaultAvatar.margin = 4;
            recipient.avatar.add(defaultAvatar);
        }
        recipient.layout.attach(recipient.avatar, 0, 0, 1, 2);
        
        recipient.contact = new Gtk.Label({
            label: (contactName) ? contactName : _("Unknown Contact"),
            visible: true,
            can_focus: false,
            xalign: 0,
            hexpand: true
        });
        recipient.layout.attach(recipient.contact, 1, 0, 1, 1);
        
        recipient.phone = new Gtk.Label({
            label: phoneNumber,
            visible: true,
            can_focus: false,
            xalign: 0,
            hexpand: true
        });
        recipient.layout.attach(recipient.phone, 1, 1, 1, 1);
        
        let removeButton = new Gtk.Button({
            image: Gtk.Image.new_from_icon_name(
                "edit-delete-symbolic",
                Gtk.IconSize.BUTTON
            ),
            always_show_image: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER
        });
        removeButton.get_style_context().add_class("circular");
        removeButton.connect("clicked", () => {
            this.emit("remove-recipient", phoneNumber.replace(/\D/g, ""));
        });
        recipient.layout.attach(removeButton, 2, 0, 1, 2);
        
        recipient.show_all();
    },
    
    removeRecipient: function (phoneNumber) {
        this.list.foreach((row) => {
            if (row.phone.label.replace(/\D/g, "") === phoneNumber) {
                this.list.remove(row);
            }
        });
    }
});


/**
 * A Gtk.ScrolledWindow with Gtk.ListBox for storing threads of messages
 */
var MessageList = new Lang.Class({
    Name: "GSConnectMessageList",
    Extends: Gtk.ScrolledWindow,
    
    _init: function () {
        this.parent({
            can_focus: false,
            hexpand: true,
            vexpand: true
        });
        
        let frame = new Gtk.Frame();
        this.add(frame);
        
        this.list = new Gtk.ListBox({
            visible: true,
            halign: Gtk.Align.FILL
        });
        this.list.connect("size-allocate", (widget) => {
            let vadj = this.get_vadjustment();
            vadj.set_value(vadj.get_upper() - vadj.get_page_size());
        });
        frame.add(this.list);
    },
    
    /**
     * Add a new thread, which includes a single instance of the sender's
     * avatar and a series of sequential messages from one user.
     *
     * @param {string} sender - The user visible name (or number) of the sender
     * @param {string} phoneThumbnail - A base64 encoded bytearray of a JPEG
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
     * @return {Gtk.ListBoxRow} - The new thread
     */
    addThread: function (sender, phoneThumbnail, direction) {
        let thread = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false,
            hexpand: true,
            halign: Gtk.Align.FILL,
            visible: true,
            margin: 6
        });
        this.list.add(thread);
        
        thread.layout = new Gtk.Box({
            visible: true,
            can_focus: false,
            hexpand: true,
            spacing: 3,
            halign: (direction) ? Gtk.Align.START : Gtk.Align.END
        });
        thread.add(thread.layout);
        
        // Contact Avatar
        // TODO: GdkPixbuf chokes hard on non-fatally corrupted images
        try {
            thread.avatar = new ContactAvatar(
                phoneThumbnail,
                this.get_toplevel(),
                32
            );
        } catch (e) {
            Common.debug("Error creating avatar: " + e);
        
            thread.avatar = new Gtk.Box({
                width_request: 32,
                height_request: 32
            });
            let avatarStyle = thread.avatar.get_style_context();
            avatarStyle.add_provider(MessageStyle, 0);
            avatarStyle.add_class("contact-avatar");
            avatarStyle.add_class("contact-color-orange");
            
            let defaultAvatar = Gtk.Image.new_from_icon_name(
                "avatar-default-symbolic",
                Gtk.IconSize.LARGE_TOOLBAR
            );
            defaultAvatar.visible = true;
            defaultAvatar.margin = 4;
            thread.avatar.add(defaultAvatar);
        }
        thread.avatar.tooltip_text = sender;
        thread.avatar.valign = Gtk.Align.END;
        thread.avatar.visible = direction;
        thread.layout.add(thread.avatar);
        
        // Messages
        thread.messages = new Gtk.Box({
            visible: true,
            can_focus: false,
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 3,
            halign: (direction) ? Gtk.Align.START : Gtk.Align.END,
            margin_right: (direction) ? 32 : 0,
            margin_left: (direction) ? 0: 32
        });
        thread.layout.add(thread.messages);
        
        return thread;
    },
    
    /**
     * Add a new message, calling addThread() if necessary to create a new
     * thread.
     *
     * @param {string} sender - The user visible name (or number) of the sender
     * @param {string} messageBody - The message content
     * @param {string} phoneThumbnail - A base64 encoded bytearray of a JPEG
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
     * @return {Gtk.ListBoxRow} - The new thread
     */
    addMessage: function (sender, messageBody, phoneThumbnail, direction) {
        let nthreads = this.list.get_children().length;
        let thread, currentThread;
        
        if (nthreads) {
            let currentThread = this.list.get_row_at_index(nthreads - 1);
            
            if (currentThread.avatar.tooltip_text === sender) {
                thread = currentThread;
            }
        }
        
        if (!thread) {
            thread = this.addThread(sender, phoneThumbnail, direction);
        }
        
        let messageBubble = new Gtk.Box({
            visible: true,
            halign: (direction) ? Gtk.Align.START : Gtk.Align.END
        });
        let messageBubbleStyle = messageBubble.get_style_context();
        messageBubbleStyle.add_provider(MessageStyle, 0);
        messageBubbleStyle.add_class("message-bubble");
        thread.messages.add(messageBubble);
        
        let messageContent = new Gtk.Label({
            label: messageBody,
            margin_top: 6,
            margin_bottom: 6,
            margin_right: 12,
            margin_left: 12,
            selectable: true,
            visible: true,
            wrap: true,
            xalign: direction
        });
        messageBubble.add(messageContent);
        
        if (direction === MessageDirection.IN) {
            messageBubbleStyle.add_class("contact-color-orange");
        } else if (direction === MessageDirection.OUT) {
            messageBubbleStyle.add_class("contact-color-grey");
        }
    }
});


    }
});


/**
 * A Gtk.ApplicationWindow for SMS conversations
 */
var ConversationWindow = new Lang.Class({
    Name: "GSConnectConversationWindow",
    Extends: Gtk.ApplicationWindow,
    Properties: {
        "recipients": GObject.param_spec_variant(
            "recipients",
            "RecipientList", 
            "A list of target recipient phone numbers",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        )
    },
    
    _init: function(application, device) {
        this.parent({
            application: application,
            title: _("SMS Conversation"),
            default_width: 300,
            default_height: 300,
            icon_name: "phone"
        });
        
        this.device = device;
        this.plugin = this.device._plugins.get("telephony");
        this._recipients = new Map();
        
        // Header Bar
        this.headerBar = new Gtk.HeaderBar({
            show_close_button: true,
            title: _("New SMS Conversation")
        });
        this.connect("notify::recipients", () => {
            if (this._recipients.size) {
                let firstRecipient = this._recipients.values().next().value;
                
                if (firstRecipient.contactName) {
                    this.headerBar.set_title(firstRecipient.contactName);
                    this.headerBar.set_subtitle(firstRecipient.phoneNumber);
                } else {
                    this.headerBar.set_title(firstRecipient.phoneNumber);
                }
                
                if (this._recipients.size > 1) {
                    let num = this._recipients.size - 1;
                    
                    this.headerBar.set_subtitle(
                        Gettext.ngettext(
                            "And one other contact",
                            "And %d other contacts",
                            num
                        ).format(num)
                    );
                }
            } else {
                // TODO: ???
            }
        });
        this.set_titlebar(this.headerBar);
        
        // FIXME: Contact Button
        this.contactButton = new Gtk.Button({
            image: Gtk.Image.new_from_icon_name(
                "contact-new-symbolic",
                Gtk.IconSize.BUTTON
            ),
            always_show_image: true,
            // TRANSLATORS: eg. Send a link to Google Pixel
            tooltip_text: _("Add or remove contacts")
        });
        this.contactButton.connect("clicked", () => {
            this.headerBar.custom_title = this.contactEntry;
            this.contactEntry.has_focus = true;
            this.contactEntry.set_position(-1);
            this.recipientList.visible = true;
            
            this.contactButton.visible = false;
            this.messageList.visible = false;
        });
        this.headerBar.pack_start(this.contactButton);
        
        // Contact Entry
        this.contactEntry = new ContactEntry(new ContactCompletion());
        this.contactEntry.connect("notify::recipients", (entry) => {
            log("RECIPIENTS CHANGED: " + Array.from(entry.recipients.values()));
            
            for (let contact of Array.from(entry.recipients.values())) {
                this.addRecipient(contact);
            }
            entry.text = "";
            
            this.headerBar.custom_title = null;
            this.recipientList.visible = false;
            
            this.contactButton.visible = true;
            this.messageList.visible = true;
        });
        this.device.bind_property(
            "connected",
            this.contactEntry,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.headerBar.custom_title = this.contactEntry;
        
        // Content Layout
        this.layout = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin: 6,
            spacing: 6
        });
        this.add(this.layout);
        
        // InfoBar
        this.infoBar = new Gtk.InfoBar({
            message_type: Gtk.MessageType.WARNING
        });
        this.infoBar.get_content_area().add(
            new Gtk.Image({ icon_name: "dialog-warning-symbolic" })
        );
        this.infoBar.get_content_area().add(
            new Gtk.Label({
                // TRANSLATORS: eg. <b>Google Pixel</b> is disconnected
                label: _("<b>%s</b> is disconnected").format(this.device.name),
                use_markup: true
            })
        );
        // See: https://bugzilla.gnome.org/show_bug.cgi?id=710888
        this.device.connect("notify::connected", () => {
            if (!this.device.connected) {
                this.layout.add(this.infoBar);
                this.layout.reorder_child(this.infoBar, 0);
                this.infoBar.show_all();
            } else if (this.device.connected) {
                this.infoBar.hide();
                this.layout.remove(this.infoBar);
            }
        });
        
        // Message List
        this.messageList = new MessageList();
        this.device.bind_property(
            "connected",
            this.messageList,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.layout.add(this.messageList);
        
        // Recipient List
        this.recipientList = new RecipientList();
        this.recipientList.connect("remove-recipient", (widget, phoneNumber) => {
            log("REMOVING: " + phoneNumber);
            this.removeRecipient(phoneNumber);
        });
        this.device.bind_property(
            "connected",
            this.recipientList,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.layout.add(this.recipientList);
        
        // Message Entry
        this.messageEntry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _("Type an SMS message"),
            secondary_icon_name: "sms-send",
            secondary_icon_activatable: true,
            secondary_icon_sensitive: false
        });
        
        this.messageEntry.connect("changed", (entry, signal_id, data) => {
            entry.secondary_icon_sensitive = (entry.text.length) ? true : false;
        });
        
        this.messageEntry.connect("activate", (entry, signal_id, data) => {
            this.send(entry, signal_id, data);
        });
        
        this.messageEntry.connect("icon-release", (entry, signal_id, data) => {
            this.send(entry, signal_id, data);
        });
        
        this.device.bind_property(
            "connected",
            this.messageEntry,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.layout.add(this.messageEntry);
        
        // Finish initing
        this.show_all();
        this.contactButton.visible = false;
        this.messageList.visible = false;
        this.has_focus = true;
    },
    
    get recipients () {
        return Array.from(this._recipients.keys());
    },
    
    /**
     * Search the completion model for a matching phone number
     *
     * @param {string} phoneNumber - A phone number
     * @return {object} - Object of {contactName, phoneNumber} or {}
     */
    getContact: function (phoneNumber) {
        let contact, strippedContact;
        let strippedNumber = phoneNumber.replace(/\D/g, "");
        let model = this.contactEntry.get_completion().get_model();
        
        model.foreach((model, path, tree_iter) => {
            strippedContact = model.get_value(tree_iter, 2).replace(/\D/g, "");
            
            if (strippedNumber === strippedContact) {
                contact = {
                    contactName: model.get_value(tree_iter, 1),
                    phoneNumber: model.get_value(tree_iter, 2)
                };
            }
        });
        
        return (contact) ? contact : {};
    },
    
    /**
     * Add a contact, or phone number to the list of recipients
     *
     */
    addRecipient: function (phoneNumber, contactName, phoneThumbnail) {
        let strippedNumber = phoneNumber.replace(/\D/g, "");
        
        // Prefer data from the ContactCompletion
        let newRecipient = Object.assign({
            phoneNumber: phoneNumber,
            contactName: contactName,
            phoneThumbnail: phoneThumbnail
        }, this.getContact(phoneNumber));
        
        // This is an extant recipient
        if (this._recipients.has(strippedNumber)) {
            // TODO: is the set() call necessary?
            this._recipients.set(
                strippedNumber,
                Object.assign(
                    this._recipients.get(strippedNumber),
                    newRecipient
                )
            );
        // This is a new recipient
        } else {
            this._recipients.set(strippedNumber, newRecipient);
            this.recipientList.addRecipient(
                newRecipient.phoneNumber,
                newRecipient.contactName,
                newRecipient.phoneThubnail
            );
        }
        
        this.notify("recipients");
    },
    
    /**
     * Remove a contact by phone number from the list of recipients
     */
    removeRecipient: function (phoneNumber) {
        let strippedNumber = phoneNumber.replace(/\D/g, "");
        
        if (this._recipients.has(strippedNumber)) {
            this._recipients.delete(strippedNumber);
            this.recipientList.removeRecipient(strippedNumber);
            this.notify("recipients");
        }
    },
    
    /** Log an incoming message in the MessageList */
    receive: function (sender, messageBody, phoneThumbnail=false) {
        this.messageList.addMessage(
            sender,
            messageBody,
            phoneThumbnail,
            MessageDirection.IN
        );
    },
    
    /** Send the contents of ContactEntry to each recipient */
    send: function (entry, signal_id, event) {
        // Check a number/contact has been provided
        if (!this.recipients.length) {
            this.contactEntry.has_focus = true;
            this.contactEntry.secondary_icon_name = "dialog-error-symbolic";
            let styleContext = this.contactEntry.get_style_context();
            
            if (!styleContext.has_class("error")) {
                styleContext.add_class("error");
            }
            
            return false;
        }
        
        // Send to each number
        for (let number of this.recipients) {
            this.plugin.sendSms(number, entry.text);
        }
        
        // Log the outgoing message
        this.messageList.addMessage(
            // TRANSLATORS: A prefix for sent SMS messages
            // eg. You: Hello from me!
            // FIXME: unnecessary, never shown
            _("You"),
            entry.text,
            null,
            MessageDirection.OUT
        );
        entry.text = "";
    }
});

