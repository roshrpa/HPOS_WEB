# Super admin console

Open `https://YOUR-DOMAIN/super`. Only the super admin can sign in there (shop users cannot).

## Make (or reset) the super admin
Run once on the server (needs the ADMIN_TOKEN from `.env`; the password must be 10+ characters):

    curl -s -X POST https://YOUR-DOMAIN/admin/super -H "X-Admin-Token: <ADMIN_TOKEN>" -H "Content-Type: application/json" \
      -d '{"name":"Roshan","password":"a-long-password"}'

## What the console does
- Companies and branches (each branch has a shop code typed once on every device).
- Branch admin: creates the branch's first admin (Owner) or resets his PIN. The admin then makes the users of his own branch.
- Users allowed: the branch admin cannot create more active users than this.
- Licence end date and Switched off (nobody of the branch can sign in or sync).
- Go-live reset: clears every trading record of one branch on all its devices (bills, tablet orders, purchases, expenses, cash, credit payments, stock counts, waste, day closings, the audit log) and sets all stock to 0. It keeps users, roles and permissions, menu and prices, settings, expense categories, materials, recipes, portions, suppliers and customers. Type the shop code to confirm. It cannot be undone.

Existing data lives in company "Hollywood", branch "Branch 1", shop code `hollywood1`. Devices that send no shop code (old app versions) are put there.
