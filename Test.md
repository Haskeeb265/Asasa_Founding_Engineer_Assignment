- The font size of PKR Wallet is perfect. However the font size of your gold and platform inventory are not matching the font size of PKR wallet. It needs to be consistent. Make the gold and platform font size same as PKR wallet.
- The price fetch UI seems misleading. In the table the prices are being consistently fetched and updated within the specified time interval (5 minutes) however on the UI i'm constantly seeing "fetched 0s ago" and sometimes "fetched 1s ago" and "source updated 600" seconds ago. The "source updated 600" turns out to be running in a loop. it counts towards 601-610 and then resets back to 600. Instead I want it to start from 0 all the way upto the specified time interval. Also tell me the difference between fetched vs price updated. doesn't that imply the same thing to the user? Like from a dev perspective i see the difference between fetching the raw price, normalizing it, and then updating it in the db but the user doesn't have to know all that. Instead of "fetched 0s ago" and "source updated 600s ago", write a single "price updated Xs ago"

- Another thing I noticed is that even if I pause all the sources, I can still create quotes. This is NOT acceptable. Here are the conditions:
1. If all sources are paused, tell the user that currently there's no price available. try again later, and pause trade This should reflect on the UI as well. Right now if i turn off all the sources, I can still see the last fetched price on the UI when i shouldn't.
2. If only 1 source is turned on, tell the user that price is unreliable and cannot be validated and pause trade. Hence try again later. HOWEVER if that single source is Pakgold.pk, do not pause trade.
3. If the single source is Goldprice.org OR yahoo, tell the user that price is unreliable. try again later and pause trade.
4. If Goldprice.org and Yahoo are available, should Goldprice.org's price and let trade continue. In the least we need atleast 2 sources to be available for trading to continue. Except for the case of PakGold.pk where if only that souce is availble, we let the trading continue.
5. IMPORTANT: All the above conditions apply only after the price's max age is gone by. If the above cases are present but the max age is still not expired then we let the user conitnue trading.

- Check the TLL Quote timer. If I set it to 10, it starts from 6. If I set it to 75, it starts from 71. THere's a 4 second gap for some reason. Make it consistent.
- Tell me what's the use of "Source C basis" in my Settings table.



turn all user communications like pauses notifications, trade succesful, trade cancelled etc into toast noticiations. 